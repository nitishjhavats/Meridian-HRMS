import type { AttendanceStatus, RegularisationStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { type DateOnly, todayInZone, zonedTimeToInstant } from "@/domain/date";
import { applyDayOverride } from "./admin";

/**
 * Attendance regularisation.
 *
 * Without this, a missed punch has no employee-side remedy — only an admin
 * override, which means chasing somebody. Here the person explains what
 * happened, a manager decides, and an approval applies the correction through
 * the same `overrideDay` path an admin would use, so there is exactly one way a
 * day's status ever changes.
 */

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/** How far back somebody may ask for a correction. */
const WINDOW_DAYS = 45;

export interface RequestRegularisationInput {
  date: DateOnly;
  requestedStatus: AttendanceStatus;
  /** Wall-clock times in the organisation's zone, e.g. "09:15". */
  checkIn?: string;
  checkOut?: string;
  reason: string;
}

export async function requestRegularisation(
  ctx: AuthContext,
  input: RequestRegularisationInput,
) {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.regularise.request", "attendance");

  const employeeId = ctx.employeeId;
  if (!employeeId) throw new ValidationError("Your login is not linked to an employee record.");

  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new ValidationError("Say what happened — your manager decides on this.");
  }

  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const today = todayInZone(timezone);
  if (input.date > today) {
    throw new ValidationError("You cannot regularise a day that has not happened yet.");
  }

  const earliest = new Date(`${today}T00:00:00.000Z`);
  earliest.setUTCDate(earliest.getUTCDate() - WINDOW_DAYS);
  if (input.date < toDateOnly(earliest)) {
    throw new ValidationError(
      `Regularisation is open for ${WINDOW_DAYS} days. For anything older, ask HR to correct it directly.`,
    );
  }

  // One open request per day — the model enforces it, but a clear message beats
  // a unique-constraint error.
  const existing = await prisma.attendanceRegularisation.findUnique({
    where: { employeeId_date: { employeeId, date: toDate(input.date) } },
    select: { id: true, status: true },
  });
  if (existing) {
    throw new ConflictError(
      existing.status === "PENDING"
        ? "You already have a request open for that day."
        : `That day was already ${existing.status.toLowerCase()}. Ask HR if it still looks wrong.`,
    );
  }

  const request = await prisma.attendanceRegularisation.create({
    data: {
      organizationId: ctx.organizationId,
      employeeId,
      date: toDate(input.date),
      requestedStatus: input.requestedStatus,
      requestedCheckIn: input.checkIn
        ? zonedTimeToInstant(input.date, toMinutes(input.checkIn), timezone)
        : null,
      requestedCheckOut: input.checkOut
        ? zonedTimeToInstant(input.date, toMinutes(input.checkOut), timezone)
        : null,
      reason,
    },
  });

  await writeAudit(ctx, {
    action: "attendance.regularised",
    entityType: "AttendanceRegularisation",
    entityId: request.id,
    after: { date: input.date, requestedStatus: input.requestedStatus, reason },
  });

  await notify.toOrgRoles(ctx.organizationId, ["HR_MANAGER", "ADMIN", "ORG_OWNER"], {
    type: "attendance.regularise",
    title: "Attendance correction requested",
    body: `${ctx.name ?? "An employee"} asked to correct ${input.date}.`,
    link: "/attendance",
  });

  return { id: request.id, date: input.date };
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  if (h == null || m == null || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new ValidationError(`"${time}" is not a valid time.`);
  }
  return h * 60 + m;
}

export interface RegularisationRow {
  id: string;
  date: DateOnly;
  requestedStatus: AttendanceStatus;
  requestedCheckIn: string | null;
  requestedCheckOut: string | null;
  reason: string;
  status: RegularisationStatus;
  reviewNote: string | null;
  createdAt: string;
  employee: { id: string; name: string; code: string };
  /** What the day says now, so a reviewer can see what would change. */
  currentStatus: AttendanceStatus | null;
}

export async function listRegularisations(
  ctx: AuthContext,
  filters: { status?: RegularisationStatus; mine?: boolean } = {},
): Promise<RegularisationRow[]> {
  requireOrg(ctx);

  const where: Record<string, unknown> = { organizationId: ctx.organizationId };

  if (filters.mine) {
    where.employeeId = ctx.employeeId ?? "";
  } else {
    const visible = await visibleEmployeeIds(ctx, "attendance.read");
    if (visible !== null) where.employeeId = { in: visible };
  }
  if (filters.status) where.status = filters.status;

  const rows = await prisma.attendanceRegularisation.findMany({
    where,
    orderBy: [{ status: "asc" }, { date: "desc" }],
    take: 200,
    select: {
      id: true,
      employeeId: true,
      date: true,
      requestedStatus: true,
      requestedCheckIn: true,
      requestedCheckOut: true,
      reason: true,
      status: true,
      reviewNote: true,
      createdAt: true,
      employee: {
        select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
      },
    },
  });

  if (rows.length === 0) return [];

  const days = await prisma.attendanceDay.findMany({
    where: {
      organizationId: ctx.organizationId,
      OR: rows.map((r) => ({ employeeId: r.employeeId, date: r.date })),
    },
    select: { employeeId: true, date: true, status: true },
  });
  const current = new Map(days.map((d) => [`${d.employeeId}:${toDateOnly(d.date)}`, d.status]));

  return rows.map((r) => ({
    id: r.id,
    date: toDateOnly(r.date),
    requestedStatus: r.requestedStatus,
    requestedCheckIn: r.requestedCheckIn?.toISOString() ?? null,
    requestedCheckOut: r.requestedCheckOut?.toISOString() ?? null,
    reason: r.reason,
    status: r.status,
    reviewNote: r.reviewNote,
    createdAt: r.createdAt.toISOString(),
    employee: {
      id: r.employee.id,
      name: employeeName(r.employee, "—"),
      code: r.employee.employeeCode,
    },
    currentStatus: current.get(`${r.employeeId}:${toDateOnly(r.date)}`) ?? null,
  }));
}

/**
 * Decides a request.
 *
 * Approval routes through `overrideDay`, so an approved correction is recorded
 * exactly like an admin one — same audit action, same `overriddenBy`, same
 * preserved `systemStatus`. There is no second path by which a day changes.
 */
export async function decideRegularisation(
  ctx: AuthContext,
  id: string,
  decision: "APPROVED" | "REJECTED",
  note?: string,
) {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.regularise.approve", "attendance");

  const request = await prisma.attendanceRegularisation.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { employee: { select: { id: true, userId: true } } },
  });
  if (!request) throw new NotFoundError("That request");
  if (request.status !== "PENDING") {
    throw new ConflictError(`That request was already ${request.status.toLowerCase()}.`);
  }
  if (request.employee.userId === ctx.userId) {
    throw new ValidationError("You cannot approve your own attendance correction.");
  }

  // The queue was scoped and the decision was not, so anybody holding
  // `attendance.regularise.approve` could decide a request from any team in the
  // organisation. `null` means no restriction -- reading it as "nothing
  // visible" is the inversion that has already caused one security finding
  // here, so it is checked explicitly.
  const visible = await visibleEmployeeIds(ctx, "attendance.read");
  if (visible !== null && !visible.includes(request.employee.id)) {
    // Not 403: a request outside your team is one you should not know exists.
    throw new NotFoundError("That request");
  }

  const date = toDateOnly(request.date);

  // The day changes first, and the request is only marked decided once it has.
  //
  // This used to run the other way round, and `overrideDay` requires
  // `attendance.override` -- which a TEAM_LEAD holding
  // `attendance.regularise.approve` does not have. So a team lead approving a
  // correction left the request APPROVED and the day untouched, outside any
  // transaction, and the employee was told their correction had gone through
  // while payroll went on paying the old figure. Ordering it this way means a
  // failure leaves the request PENDING, which is true.
  if (decision === "APPROVED") {
    await applyDayOverride(ctx, {
      employeeId: request.employeeId,
      date,
      status: request.requestedStatus,
      reason: `Regularisation approved: ${request.reason}`,
    });

    // Times only matter when they were asked for.
    if (request.requestedCheckIn || request.requestedCheckOut) {
      await prisma.attendanceDay.update({
        where: {
          employeeId_date: { employeeId: request.employeeId, date: request.date },
        },
        data: {
          ...(request.requestedCheckIn ? { firstCheckInAt: request.requestedCheckIn } : {}),
          ...(request.requestedCheckOut ? { lastCheckOutAt: request.requestedCheckOut } : {}),
        },
      });
    }
  }

  await prisma.attendanceRegularisation.update({
    where: { id },
    data: {
      status: decision,
      reviewedById: ctx.userId,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || null,
    },
  });

  if (request.employee.userId) {
    await notify.toUser(request.employee.userId, {
      type: "attendance.regularise",
      title: decision === "APPROVED" ? "Attendance correction approved" : "Attendance correction declined",
      body:
        decision === "APPROVED"
          ? `${date} has been corrected.`
          : `Your request for ${date} was not approved.${note ? ` ${note}` : ""}`,
      link: "/me/attendance",
    });
  }

  return { id, status: decision };
}

export async function cancelRegularisation(ctx: AuthContext, id: string) {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.regularise.request", "attendance");

  const request = await prisma.attendanceRegularisation.findFirst({
    where: { id, organizationId: ctx.organizationId, employeeId: ctx.employeeId ?? "" },
    select: { id: true, status: true },
  });
  if (!request) throw new NotFoundError("That request");
  if (request.status !== "PENDING") {
    throw new ConflictError("Only a request that is still pending can be withdrawn.");
  }

  await prisma.attendanceRegularisation.update({
    where: { id },
    data: { status: "CANCELLED" },
  });

  return { id, status: "CANCELLED" as const };
}
