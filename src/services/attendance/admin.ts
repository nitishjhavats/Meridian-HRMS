import type { AttendanceStatus } from "@prisma/client";
import {
  type MonthTotals,
  countDay,
  emptyMonthTotals,
} from "@/domain/attendance/monthTotals";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { type DateOnly, daysInMonth, monthLabel, todayInZone } from "@/domain/date";

/**
 * The admin view of attendance.
 *
 * A month grid rather than a list, because the questions people bring to this
 * screen are shaped like a grid: "who was out on the 14th" reads down a column,
 * "what did Sneha do all month" reads across a row. A paginated list answers
 * neither without work.
 *
 * An override never edits what was recorded. `systemStatus` keeps what the
 * rules concluded and `status` carries the human decision, so a corrected day
 * still shows that a correction happened and who made it.
 */

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

export interface GridDay {
  date: DateOnly;
  day: number;
  status: AttendanceStatus;
  systemStatus: AttendanceStatus;
  /** True when a person changed it — the grid marks these. */
  overridden: boolean;
  lateMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  firstCheckInAt: string | null;
  lastCheckOutAt: string | null;
  /**
   * Where each punch was taken from, and how sure the phone was.
   *
   * The accuracy no longer gates a mark -- the 35 m gate turned old phones
   * away at the counter and the grid showed a blank -- so it is shown here
   * instead, beside the distance it qualifies. Null when the punch is not on
   * the day (or was taken back).
   */
  checkIn: { distanceMeters: number | null; accuracyMeters: number | null } | null;
  checkOut: { distanceMeters: number | null; accuracyMeters: number | null } | null;
  /** Present only when there is a day row at all. */
  id: string | null;
  flagged: boolean;
}

type PunchFacts = { distanceMeters: number | null; accuracyMeters: number | null };

export interface GridRow {
  employeeId: string;
  name: string;
  code: string;
  designation: string | null;
  days: GridDay[];
  totals: MonthTotals;
}

export interface MonthlyGrid {
  year: number;
  month: number;
  label: string;
  dates: DateOnly[];
  rows: GridRow[];
  /** Days that need somebody's attention, for the banner. */
  flaggedCount: number;
}

export async function getMonthlyGrid(
  ctx: AuthContext,
  options: { year: number; month: number; employeeId?: string },
): Promise<MonthlyGrid> {
  requireOrg(ctx);

  const { year, month } = options;
  if (month < 1 || month > 12) throw new ValidationError("That is not a month.");

  const total = daysInMonth(year, month);
  const dates: DateOnly[] = [];
  for (let d = 1; d <= total; d++) {
    dates.push(`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }

  const visible = await visibleEmployeeIds(ctx, "attendance.read");
  // The whole-organisation grid is the people who are here; a named person is
  // whoever was asked for. Somebody who has resigned keeps their record and
  // their recorded days, and "the final month before the settlement" is the
  // month HR most needs to see -- filtering on `active` here answered it with
  // "Nothing recorded" for every month they ever worked.
  const employeeWhere: Record<string, unknown> = {
    organizationId: ctx.organizationId,
    ...(options.employeeId ? {} : { active: true }),
  };
  if (visible !== null) employeeWhere.id = { in: visible };
  if (options.employeeId) {
    if (visible !== null && !visible.includes(options.employeeId)) {
      return { year, month, label: monthLabel(year, month), dates, rows: [], flaggedCount: 0 };
    }
    employeeWhere.id = options.employeeId;
  }

  // Everybody in scope, with no cap. There was a `take: 200` here, and it was
  // silent: the two-hundred-and-first person by employee code was simply not
  // on the grid, and the tiles the page sums from these rows undercounted with
  // nothing to say so. A grid a manager plans around, and payroll is
  // reconciled against, has to be complete before it is quick; when an
  // organisation outgrows one screen the answer is a filter or a pager the
  // reader can see, never a cut they cannot.
  const employees = await prisma.employee.findMany({
    where: employeeWhere,
    orderBy: { employeeCode: "asc" },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      user: { select: { name: true } },
      designation: { select: { title: true } },
    },
  });

  if (employees.length === 0) {
    return { year, month, label: monthLabel(year, month), dates, rows: [], flaggedCount: 0 };
  }

  const [days, flaggedEvents, punches] = await Promise.all([
    prisma.attendanceDay.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: { in: employees.map((e) => e.id) },
        date: { gte: toDate(dates[0]!), lte: toDate(dates[dates.length - 1]!) },
      },
      select: {
        id: true,
        employeeId: true,
        date: true,
        status: true,
        systemStatus: true,
        overriddenById: true,
        lateMinutes: true,
        workedMinutes: true,
        overtimeMinutes: true,
        firstCheckInAt: true,
        lastCheckOutAt: true,
      },
    }),
    // A face-match failure is the other reason a day needs a human look.
    prisma.attendanceEvent.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: { in: employees.map((e) => e.id) },
        flaggedForReview: true,
        reviewedAt: null,
        occurredAt: { gte: toDate(dates[0]!) },
      },
      select: { employeeId: true, occurredAt: true },
    }),
    // The punches themselves, for the distance and the accuracy behind each
    // one. Keyed by the day they were written to rather than by `occurredAt`:
    // a 00:30 check-in in Kolkata is the previous UTC date, and the day row is
    // the org-local one. A refused attempt has no day and is not a punch.
    prisma.attendanceEvent.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: { in: employees.map((e) => e.id) },
        attendanceDay: { date: { gte: toDate(dates[0]!), lte: toDate(dates[dates.length - 1]!) } },
      },
      orderBy: { occurredAt: "asc" },
      select: {
        employeeId: true,
        type: true,
        distanceMeters: true,
        accuracyMeters: true,
        attendanceDay: { select: { date: true } },
      },
    }),
  ]);

  const flaggedByDay = new Set(
    flaggedEvents.map((e) => `${e.employeeId}:${toDateOnly(e.occurredAt)}`),
  );

  // The last check-in and the last check-out per employee and day, which are
  // the punches `firstCheckInAt` and `lastCheckOutAt` on the row came from. The
  // *last* check-in, not the first: a rejected check-in keeps its event and
  // loses its time, and the re-mark that follows it is a later event -- the
  // grid was showing the rejected punch's distance beside the real one's time.
  // The events arrive oldest first, so the latest of each kind wins.
  const punchByDay = new Map<string, { checkIn: PunchFacts | null; checkOut: PunchFacts | null }>();
  for (const punch of punches) {
    if (!punch.attendanceDay) continue;
    const key = `${punch.employeeId}:${toDateOnly(punch.attendanceDay.date)}`;
    const entry = punchByDay.get(key) ?? { checkIn: null, checkOut: null };
    const facts: PunchFacts = { distanceMeters: punch.distanceMeters, accuracyMeters: punch.accuracyMeters };
    if (punch.type === "CHECK_IN") {
      entry.checkIn = facts;
    } else {
      entry.checkOut = facts;
    }
    punchByDay.set(key, entry);
  }
  const byEmployee = new Map<string, Map<string, (typeof days)[number]>>();
  for (const day of days) {
    const key = day.employeeId;
    if (!byEmployee.has(key)) byEmployee.set(key, new Map());
    byEmployee.get(key)!.set(toDateOnly(day.date), day);
  }

  let flaggedCount = 0;

  const rows: GridRow[] = employees.map((employee) => {
    const lookup = byEmployee.get(employee.id) ?? new Map();
    const totals = emptyMonthTotals();

    const gridDays: GridDay[] = dates.map((date, index) => {
      const record = lookup.get(date);
      const status: AttendanceStatus = record?.status ?? "NOT_MARKED";
      const flagged = flaggedByDay.has(`${employee.id}:${date}`);
      if (flagged) flaggedCount++;
      // Only for a punch the row still carries: a rejected check-in keeps its
      // event and loses its time, and a distance beside no time would say the
      // punch was still there.
      const punch = punchByDay.get(`${employee.id}:${date}`);
      const checkIn = record?.firstCheckInAt ? (punch?.checkIn ?? null) : null;
      const checkOut = record?.lastCheckOutAt ? (punch?.checkOut ?? null) : null;

      // One tally, shared with the reception screen. Three copies of these
      // eight branches existed and were three chances to disagree about what
      // an EXTRA_DAY is.
      countDay(totals, status, record?.lateMinutes ?? 0);

      return {
        date,
        day: index + 1,
        status,
        systemStatus: record?.systemStatus ?? "NOT_MARKED",
        overridden: Boolean(record?.overriddenById),
        lateMinutes: record?.lateMinutes ?? 0,
        workedMinutes: record?.workedMinutes ?? 0,
        overtimeMinutes: record?.overtimeMinutes ?? 0,
        firstCheckInAt: record?.firstCheckInAt?.toISOString() ?? null,
        lastCheckOutAt: record?.lastCheckOutAt?.toISOString() ?? null,
        checkIn,
        checkOut,
        id: record?.id ?? null,
        flagged,
      };
    });

    return {
      employeeId: employee.id,
      name: employeeName(employee, "—"),
      code: employee.employeeCode,
      designation: employee.designation?.title ?? null,
      days: gridDays,
      totals,
    };
  });

  return { year, month, label: monthLabel(year, month), dates, rows, flaggedCount };
}

// ------------------------------------------------------------------ override

export interface OverrideInput {
  employeeId: string;
  date: DateOnly;
  status: AttendanceStatus;
  reason: string;
}

/**
 * Corrects a day.
 *
 * A reason is required, not optional. An override with no explanation is
 * indistinguishable from a mistake when somebody queries their payslip three
 * months later, and this is the field that answers them.
 */
export async function overrideDay(ctx: AuthContext, input: OverrideInput) {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.override", "attendance");

  // Attendance decides payable days, which is pay. A role scoped to its own
  // team must not be able to change somebody else's day by id. `null` means no
  // restriction, which is what every organisation-wide holder gets, so this is
  // a no-op for HR, Admin and the owner.
  const visible = await visibleEmployeeIds(ctx, "attendance.read");
  if (visible !== null && !visible.includes(input.employeeId)) {
    throw new NotFoundError("That employee");
  }

  return applyDayOverride(ctx, input);
}

/**
 * The mechanics, with no permission check of its own.
 *
 * There is still exactly one way a day changes -- same audit action, same
 * `overriddenBy`, same preserved `systemStatus` -- but two things authorise
 * it: an administrator holding `attendance.override`, and approving somebody's
 * correction request, which is authorised by `attendance.regularise.approve`.
 *
 * Splitting them fixes a live bug. `TEAM_LEAD` holds the second permission and
 * not the first, so `decideRegularisation` marked the request APPROVED and then
 * threw 403 here -- outside any transaction, so the request stood. The employee
 * was told their correction was approved, the day was never changed, and
 * payroll paid the old figure.
 *
 * Callers must do their own scope check. `overrideDay` and
 * `decideRegularisation` both do.
 */
export async function applyDayOverride(ctx: AuthContext, input: OverrideInput) {
  requireOrg(ctx);

  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new ValidationError("Give a reason for the change — it is kept with the record.");
  }

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, organizationId: ctx.organizationId },
    select: { id: true, userId: true, shiftId: true },
  });
  if (!employee) throw new NotFoundError("That employee");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  if (input.date > today) {
    throw new ValidationError("Attendance cannot be set for a day that has not happened yet.");
  }

  const existing = await prisma.attendanceDay.findUnique({
    where: { employeeId_date: { employeeId: input.employeeId, date: toDate(input.date) } },
    select: { id: true, status: true, systemStatus: true },
  });

  const day = await prisma.attendanceDay.upsert({
    where: { employeeId_date: { employeeId: input.employeeId, date: toDate(input.date) } },
    create: {
      organizationId: ctx.organizationId,
      employeeId: input.employeeId,
      date: toDate(input.date),
      status: input.status,
      // Nothing was recorded, so the rules concluded nothing.
      systemStatus: "NOT_MARKED",
      shiftId: employee.shiftId,
      source: "ADMIN_MANUAL",
      overriddenById: ctx.userId,
      overriddenAt: new Date(),
      overrideReason: reason,
    },
    update: {
      status: input.status,
      overriddenById: ctx.userId,
      overriddenAt: new Date(),
      overrideReason: reason,
    },
  });

  await writeAudit(ctx, {
    action: "attendance.overridden",
    entityType: "AttendanceDay",
    entityId: day.id,
    before: existing ? { status: existing.status, systemStatus: existing.systemStatus } : null,
    after: { status: input.status, date: input.date, reason },
  });

  if (employee.userId) {
    await notify.toUser(employee.userId, {
      type: "attendance.overridden",
      title: "Your attendance was changed",
      body: `${input.date} is now marked ${input.status.replaceAll("_", " ").toLowerCase()}. ${reason}`,
      link: "/me/attendance",
    });
  }

  return { id: day.id, date: input.date, status: input.status };
}

/** Clears a flagged face-match so it stops asking for attention. */
export async function reviewFlaggedEvents(ctx: AuthContext, employeeId: string, date: DateOnly) {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.override", "attendance");

  const start = toDate(date);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const result = await prisma.attendanceEvent.updateMany({
    where: {
      organizationId: ctx.organizationId,
      employeeId,
      flaggedForReview: true,
      reviewedAt: null,
      occurredAt: { gte: start, lt: end },
    },
    data: { reviewedById: ctx.userId, reviewedAt: new Date() },
  });

  return { reviewed: result.count };
}
