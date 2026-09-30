import type { LeaveRequestStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { liveReportingWhere } from "@/domain/reporting/window";
import { resolveWeeklyOff } from "@/services/org/weeklyOff";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import {
  type DateOnly,
  endOfMonth,
  monthLabel,
  parts,
  startOfMonth,
  todayInZone,
} from "@/domain/date";
import {
  type DayPart,
  type LeaveSpan,
  type MonthlyCap,
  accruedForRow,
  availableDays,
  bookedDaysByMonth,
  chargeableDaysByMonth,
  countLeaveDays,
  monthKey,
  monthsWorkedInYear,
  validateLeave,
} from "@/domain/leave";
import {
  allocationOverrides,
  designationAllocation,
  resolveAllocation,
} from "@/domain/leave/allocation";
import { leaveAttendanceDays } from "@/domain/leave/attendanceDays";
import { buildPeriodCalendar } from "@/domain/calendar";

/**
 * Leave.
 *
 * The rule that shapes this file: a balance is only ever moved by an approval,
 * never by a request. Someone asking for ten days does not lose ten days while
 * a manager thinks about it, and a rejection does not have to remember to give
 * anything back. The cost of that choice is that "available" has to subtract
 * pending requests when validating a new one, which `pendingDays` does.
 */

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

// ------------------------------------------------------------------ calendar

/**
 * The week-offs and holidays covering a span, so leave is not charged for days
 * nobody was going to work anyway.
 */
async function nonWorkingDays(
  organizationId: string,
  employeeId: string,
  start: DateOnly,
  end: DateOnly,
) {
  const [employee, holidays] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: employeeId, organizationId },
      select: {
        weeklyOffConfig: true,
        weeklyOffPattern: { select: { config: true } },
        joiningDate: true,
      },
    }),
    prisma.holiday.findMany({
      where: { organizationId, date: { gte: toDate(start), lte: toDate(end) } },
      select: { date: true },
    }),
  ]);

  // Resolved rather than guarded. This used to be `if (pattern)`, so somebody
  // on "organisation default" had *no* week-offs here -- their leave was
  // charged for a Sunday that payroll then treated as a rest day.
  const weeklyOff = await resolveWeeklyOff(prisma, organizationId, employee);

  const weekOffs = new Set<string>();
  const calendar = buildPeriodCalendar(start, end, { employeeId, weeklyOff }, []);
  for (const day of calendar.days) {
    if (day.kind === "WEEK_OFF") weekOffs.add(day.date);
  }

  return {
    weekOffs,
    holidays: new Set(holidays.map((h) => toDateOnly(h.date))),
  };
}

// ------------------------------------------------------------------ balances

export interface LeaveBalanceRow {
  leaveTypeId: string;
  code: string;
  name: string;
  color: string;
  paid: boolean;
  accrues: boolean;
  allocated: number;
  accrued: number;
  used: number;
  carriedForward: number;
  /** Requested but not yet decided — not deducted, but not spendable either. */
  pending: number;
  /** What can actually be booked right now. */
  available: number;
}

export async function getLeaveBalances(
  ctx: AuthContext,
  employeeId: string,
  year?: number,
): Promise<LeaveBalanceRow[]> {
  requireOrg(ctx);

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const forYear = year ?? Number(today.slice(0, 4));

  const [types, balances, pending, employee, allocationRows] = await Promise.all([
    prisma.leaveType.findMany({
      where: { organizationId: ctx.organizationId, active: true },
      orderBy: { code: "asc" },
    }),
    prisma.leaveBalance.findMany({
      where: { organizationId: ctx.organizationId, employeeId, year: forYear },
    }),
    prisma.leaveRequest.groupBy({
      by: ["leaveTypeId"],
      where: { organizationId: ctx.organizationId, employeeId, status: "PENDING" },
      _sum: { totalDays: true },
    }),
    prisma.employee.findFirst({
      where: { id: employeeId, organizationId: ctx.organizationId },
      select: { joiningDate: true, designationId: true },
    }),
    // What this person's job gets, where somebody has said. Small — one row per
    // deliberate exception — and the screen that edits it was, until this was
    // wired in, the only place in the product that read it.
    prisma.designationLeaveAllocation.findMany({
      where: { organizationId: ctx.organizationId },
      select: { leaveTypeId: true, designationId: true, annualAllocation: true },
    }),
  ]);

  const overrides = allocationOverrides(allocationRows);
  const byType = new Map(balances.map((b) => [b.leaveTypeId, b]));
  const pendingByType = new Map(pending.map((p) => [p.leaveTypeId, Number(p._sum.totalDays ?? 0)]));

  // Months of this year the person has actually been employed for, so a
  // mid-year joiner does not accrue a full year's worth on day one.
  const monthsWorked = monthsWorkedInYear(
    forYear,
    employee?.joiningDate ? toDateOnly(employee.joiningDate) : null,
    today,
  );

  return types.map((type) => {
    const balance = byType.get(type.id);
    const accrues = type.accrualMode === "MONTHLY";
    const designation = designationAllocation(overrides, type.id, employee?.designationId);
    // What the job is entitled to, before this one person's own figure. The
    // accrual cap is a statement about the role, not about the row: it is the
    // same number `listBalances` and the year-end run work from, and a second
    // way of reaching it here is a second way for them to disagree.
    const entitlement = resolveAllocation({ designation, type: type.annualAllocation });
    const state = {
      // The person's own figure still wins, and `resolveAllocation` is what
      // keeps that true — a stored zero is a real allocation, not an absent one.
      allocated: resolveAllocation({
        personal: balance?.allocated,
        designation,
        type: type.annualAllocation,
      }),
      // Not `balance?.accrued ?? computed`: the column is never null once a row
      // exists, and a row created by an approval or the year-end run holds a
      // zero that would otherwise read as "no leave earned this year".
      accrued: accruedForRow(balance ? Number(balance.accrued) : null, {
        annualAllocation: entitlement,
        monthlyAccrual: Number(type.monthlyAccrual),
        accrualMode: type.accrualMode as "ANNUAL" | "MONTHLY" | "NONE",
        monthsWorked,
      }),
      used: Number(balance?.used ?? 0),
      carriedForward: Number(balance?.carriedForward ?? 0),
      encashed: Number(balance?.encashed ?? 0),
    };
    const pendingDays = pendingByType.get(type.id) ?? 0;

    return {
      leaveTypeId: type.id,
      code: type.code,
      name: type.name,
      color: type.color,
      paid: type.paid,
      accrues,
      allocated: state.allocated,
      accrued: state.accrued,
      used: state.used,
      carriedForward: state.carriedForward,
      pending: pendingDays,
      available: Math.max(0, availableDays(state, accrues) - pendingDays),
    };
  });
}

// ------------------------------------------------------------------ requesting

export interface RequestLeaveInput {
  leaveTypeId: string;
  startDate: DateOnly;
  endDate: DateOnly;
  startDayPart?: DayPart;
  endDayPart?: DayPart;
  reason?: string;
}

/**
 * Preview a request without creating it.
 *
 * The form calls this as the dates change, so somebody sees the day count and
 * any problem before they commit rather than after.
 */
export async function previewLeave(ctx: AuthContext, input: RequestLeaveInput) {
  requireOrg(ctx);
  const employeeId = ctx.employeeId;
  if (!employeeId) throw new ValidationError("Your login is not linked to an employee record.");
  return evaluateRequest(ctx, employeeId, input);
}

async function evaluateRequest(
  ctx: AuthContext,
  employeeId: string,
  input: RequestLeaveInput,
  options: {
    /**
     * A request being re-priced rather than made, so its own days are not
     * counted against the month it already sits in. Nothing edits a request
     * yet; the query is shaped for the day something does.
     */
    excludeRequestId?: string;
  } = {},
) {
  const organizationId = ctx.organizationId!;
  const type = await prisma.leaveType.findFirst({
    where: { id: input.leaveTypeId, organizationId, active: true },
  });
  if (!type) throw new NotFoundError("That leave type");

  const span: LeaveSpan = {
    startDate: input.startDate,
    endDate: input.endDate,
    startDayPart: input.startDayPart ?? "FULL",
    endDayPart: input.endDayPart ?? "FULL",
  };

  // The calendar covers the whole of every month the span touches, not the
  // span alone. The monthly cap clips the requests already booked in those
  // months against the same rest days and holidays this one is counted by,
  // and a request that straddles a month end touches two of them.
  const first = parts(span.startDate);
  const last = parts(span.endDate);
  const monthsStart = startOfMonth(first.year, first.month);
  const monthsEnd = endOfMonth(last.year, last.month);
  const calendar = await nonWorkingDays(organizationId, employeeId, monthsStart, monthsEnd);
  const counted = countLeaveDays(span, calendar);

  const [balances, existing, sameType] = await Promise.all([
    getLeaveBalances(ctx, employeeId),
    prisma.leaveRequest.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: ["PENDING", "APPROVED"] },
        endDate: { gte: toDate(span.startDate) },
        startDate: { lte: toDate(span.endDate) },
      },
      select: { startDate: true, endDate: true },
    }),
    // Everything of this type already claiming a day in those months, pending
    // as well as approved: a pending request is a claim on the month the way
    // it is a claim on the balance. Only fetched when there is a cap to hold
    // it to.
    type.maxPerMonth === null
      ? Promise.resolve([])
      : prisma.leaveRequest.findMany({
          where: {
            organizationId,
            employeeId,
            leaveTypeId: type.id,
            status: { in: ["PENDING", "APPROVED"] },
            endDate: { gte: toDate(monthsStart) },
            startDate: { lte: toDate(monthsEnd) },
            ...(options.excludeRequestId ? { id: { not: options.excludeRequestId } } : {}),
          },
          select: { startDate: true, endDate: true, startDayPart: true, endDayPart: true },
        }),
  ]);

  /**
   * The cap, and what is already against it in each month this request puts a
   * day in. Booked rows are clipped to the month before they are counted, so
   * one that straddles the month end weighs on each side only for the days it
   * actually has there — the same split the new request is held to.
   */
  const requestedByMonth = chargeableDaysByMonth(span, counted);
  const monthly: MonthlyCap | null =
    type.maxPerMonth === null
      ? null
      : {
          cap: type.maxPerMonth,
          taken: bookedDaysByMonth(
            sameType.map((r) => ({
              startDate: toDateOnly(r.startDate),
              endDate: toDateOnly(r.endDate),
              startDayPart: r.startDayPart,
              endDayPart: r.endDayPart,
            })),
            // The start month as well, so the form can say what is left there
            // even when every chargeable day of the request falls elsewhere.
            [...new Set([monthKey(span.startDate), ...requestedByMonth.keys()])],
            calendar,
          ),
        };

  const balance = balances.find((b) => b.leaveTypeId === type.id);
  const problems = validateLeave({
    span,
    counted,
    rules: {
      allowHalfDay: type.allowHalfDay,
      maxConsecutive: type.maxConsecutive,
      noticeDays: type.noticeDays,
      paid: type.paid,
    },
    available: balance?.available ?? 0,
    today: todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata"),
    existing: existing.map((e) => ({
      startDate: toDateOnly(e.startDate),
      endDate: toDateOnly(e.endDate),
    })),
    monthly,
  });

  // What the form shows for the month the request starts in: the cap, what is
  // already booked there, and what that leaves before this request.
  const startMonth = monthKey(span.startDate);
  const takenThisMonth = monthly?.taken[startMonth] ?? 0;

  return {
    type: {
      id: type.id,
      name: type.name,
      code: type.code,
      paid: type.paid,
      isWeekOff: type.isWeekOff,
    },
    span,
    counted,
    available: balance?.available ?? 0,
    monthly: monthly
      ? {
          cap: monthly.cap,
          month: startMonth,
          label: monthLabel(first.year, first.month),
          taken: takenThisMonth,
          left: Math.max(0, monthly.cap - takenThisMonth),
        }
      : null,
    problems,
    ok: problems.length === 0,
  };
}

export async function requestLeave(ctx: AuthContext, input: RequestLeaveInput) {
  requireOrg(ctx);
  requireWrite(ctx, "leave.request", "leave");

  const employeeId = ctx.employeeId;
  if (!employeeId) throw new ValidationError("Your login is not linked to an employee record.");

  const evaluation = await evaluateRequest(ctx, employeeId, input);
  if (!evaluation.ok) {
    throw new ValidationError(evaluation.problems[0]!.message, {
      problems: evaluation.problems,
    });
  }

  // The reporting line decides. Falling back to anyone who can approve stops a
  // request vanishing when somebody has no manager set.
  const approver = await findApprover(ctx, employeeId);

  const request = await prisma.leaveRequest.create({
    data: {
      organizationId: ctx.organizationId,
      employeeId,
      leaveTypeId: input.leaveTypeId,
      startDate: toDate(input.startDate),
      endDate: toDate(input.endDate),
      startDayPart: input.startDayPart ?? "FULL",
      endDayPart: input.endDayPart ?? "FULL",
      totalDays: evaluation.counted.totalDays,
      reason: input.reason?.trim() || null,
      status: "PENDING",
      ...(approver
        ? { approvals: { create: { approverId: approver.userId, step: 1, status: "PENDING" } } }
        : {}),
    },
  });

  await writeAudit(ctx, {
    action: "leave.requested",
    entityType: "LeaveRequest",
    entityId: request.id,
    after: {
      leaveType: evaluation.type.code,
      startDate: input.startDate,
      endDate: input.endDate,
      totalDays: evaluation.counted.totalDays,
    },
  });

  if (approver) {
    await notify.toUser(approver.userId, {
      type: "leave.requested",
      title: "Leave request to approve",
      body: `${ctx.name ?? "An employee"} requested ${evaluation.counted.totalDays} day(s) of ${evaluation.type.name}.`,
      link: "/leave",
    });
  }

  return { id: request.id, totalDays: evaluation.counted.totalDays };
}

/**
 * Who decides this person's leave.
 *
 * Four things were wrong here, and the last one is the one nobody would have
 * guessed:
 *
 *  - `endDate` was ignored, unlike every other reporting-line read, so a
 *    manager who left in March went on receiving requests.
 *  - `take: 1` on an unordered relation meant that with two PRIMARY rows --
 *    one ended -- Postgres could return either.
 *  - A manager with no `userId`, which the bulk importer produces constantly,
 *    silently fell through to the organisation-wide fallback instead of the
 *    next manager up.
 *  - `User.status` was never checked, so a disabled leaver still holding a
 *    live line was assigned requests that then sat pending for ever.
 *
 * And the fallback's `orderBy: { role: "asc" }` is not alphabetical: Postgres
 * orders an enum by declaration order, which is seniority-first here, so the
 * *owner* became the default approver for everybody with no manager. It is
 * ordered explicitly now, least senior first -- an HR Manager should get these
 * before the person who runs the company does.
 */
/**
 * Who decides when nobody's manager can be found, least senior first.
 *
 * A manager comes before HR, and the owner is last: somebody's leave should not
 * land on the desk of the person who runs the company because their reporting
 * line was never set.
 */
const FALLBACK_APPROVER_ROLES = ["MANAGER", "HR_MANAGER", "ADMIN", "ORG_OWNER"] as const;

async function findApprover(ctx: AuthContext, employeeId: string) {
  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const live = liveReportingWhere(timezone);

  // Walk up rather than give up: a manager who cannot sign in is not an
  // approver, but the person above them might be. Bounded by the same depth
  // `teamEmployeeIds` walks, so the two agree about how deep a chain goes.
  const seen = new Set<string>([employeeId]);
  let current = employeeId;

  for (let depth = 0; depth < 6; depth++) {
    const line = await prisma.reportingRelationship.findFirst({
      where: { organizationId: ctx.organizationId!, employeeId: current, type: "PRIMARY", ...live },
      // Newest line wins when history has left more than one.
      orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
      select: { manager: { select: { id: true, user: { select: { id: true, status: true } } } } },
    });

    const manager = line?.manager;
    if (!manager || seen.has(manager.id)) break;
    if (manager.user && manager.user.status === "ACTIVE") return { userId: manager.user.id };

    seen.add(manager.id);
    current = manager.id;
  }

  const candidates = await prisma.user.findMany({
    where: {
      organizationId: ctx.organizationId!,
      status: "ACTIVE",
      role: { in: [...FALLBACK_APPROVER_ROLES] },
    },
    select: { id: true, role: true },
  });

  const rank = (role: string) => FALLBACK_APPROVER_ROLES.indexOf(role as never);
  const fallback = candidates
    .filter((u) => u.id !== ctx.userId)
    .sort((a, b) => rank(a.role) - rank(b.role))[0];

  return fallback ? { userId: fallback.id } : null;
}

// ------------------------------------------------------------------ listing

export interface LeaveListFilters {
  status?: LeaveRequestStatus;
  employeeId?: string;
  year?: number;
}

export async function listLeaveRequests(ctx: AuthContext, filters: LeaveListFilters = {}) {
  requireOrg(ctx);
  // The same matrix-aware resolver the rest of the app uses, so a Team Lead
  // sees exactly the people they see everywhere else.
  const visible = await visibleEmployeeIds(ctx, "leave.read");

  const where: Record<string, unknown> = { organizationId: ctx.organizationId };
  if (filters.status) where.status = filters.status;
  if (visible !== null) where.employeeId = { in: visible };
  if (filters.employeeId) {
    if (visible !== null && !visible.includes(filters.employeeId)) return [];
    where.employeeId = filters.employeeId;
  }

  if (filters.year) {
    where.startDate = {
      gte: toDate(`${filters.year}-01-01`),
      lte: toDate(`${filters.year}-12-31`),
    };
  }

  const requests = await prisma.leaveRequest.findMany({
    where,
    orderBy: [{ status: "asc" }, { startDate: "desc" }],
    take: 200,
    select: {
      id: true,
      startDate: true,
      endDate: true,
      startDayPart: true,
      endDayPart: true,
      totalDays: true,
      reason: true,
      status: true,
      createdAt: true,
      leaveType: { select: { name: true, code: true, color: true, paid: true } },
      employee: {
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          user: { select: { name: true } },
          designation: { select: { title: true } },
        },
      },
    },
  });

  return requests.map((r) => ({
    id: r.id,
    startDate: toDateOnly(r.startDate),
    endDate: toDateOnly(r.endDate),
    startDayPart: r.startDayPart,
    endDayPart: r.endDayPart,
    totalDays: Number(r.totalDays),
    reason: r.reason,
    status: r.status,
    requestedAt: r.createdAt.toISOString(),
    type: r.leaveType,
    employee: {
      id: r.employee.id,
      code: r.employee.employeeCode,
      name: employeeName(r.employee, "—"),
      designation: r.employee.designation?.title ?? null,
    },
  }));
}

// ------------------------------------------------------------------ deciding

export async function decideLeave(
  ctx: AuthContext,
  requestId: string,
  decision: "APPROVED" | "REJECTED",
  note?: string,
) {
  // One permission governs both outcomes: someone trusted to approve leave is
  // equally trusted to decline it.
  requireOrg(ctx);
  if (!ctx.permissions.has("leave.approve.all") && !ctx.permissions.has("leave.approve.team")) {
    throw new ValidationError("You do not have permission to decide leave requests.");
  }
  requireWrite(ctx, "leave.request", "leave");

  const request = await prisma.leaveRequest.findFirst({
    where: { id: requestId, organizationId: ctx.organizationId },
    include: {
      leaveType: true,
      employee: { select: { id: true, userId: true, designationId: true } },
    },
  });
  if (!request) throw new NotFoundError("That leave request");

  if (request.status !== "PENDING") {
    throw new ConflictError(
      `That request was already ${request.status.toLowerCase()}. Refresh to see the current state.`,
    );
  }

  // Nobody decides their own leave, whatever permissions they hold.
  if (request.employee.userId === ctx.userId) {
    throw new ValidationError("You cannot approve your own leave request.");
  }

  // The approval *queue* was team-scoped and the decision was not, so any
  // TEAM_LEAD could approve any request in the organisation by id. The family
  // is `leave.approve`, not `leave.read`: somebody who may read the whole
  // organisation but approve only their own team is a legitimate setup, and
  // this is the scope that decides. `null` means no restriction.
  const visible = await visibleEmployeeIds(ctx, "leave.approve");
  if (visible !== null && !visible.includes(request.employee.id)) {
    // A request outside your team is one you should not know exists.
    throw new NotFoundError("That leave request");
  }

  const year = request.startDate.getUTCFullYear();
  const days = Number(request.totalDays);

  /**
   * The allocation this approval will write if it is the one that creates the
   * row.
   *
   * It matters far more than it looks. The first approval of the year is what
   * brings a `LeaveBalance` row into existence, and `allocated` on that row is
   * the finest layer of the precedence — it beats the designation from then on.
   * Writing the company-wide `LeaveType.annualAllocation` here therefore did not
   * merely display the wrong number once: it froze the wrong number into the
   * person's balance for the rest of the year, so a designation that grants
   * eighteen days was overwritten by the company's twelve the moment they took
   * a single day off.
   */
  const designationRow = request.employee.designationId
    ? await prisma.designationLeaveAllocation.findFirst({
        where: {
          organizationId: ctx.organizationId,
          designationId: request.employee.designationId,
          leaveTypeId: request.leaveTypeId,
        },
        select: { annualAllocation: true },
      })
    : null;
  const allocated = resolveAllocation({
    designation: designationRow?.annualAllocation,
    type: request.leaveType.annualAllocation,
  });

  /**
   * The attendance days this decision owes.
   *
   * Until this existed, approving leave told payroll nothing whatsoever. The
   * balance moved, no `AttendanceDay` was written, and `buildPayrollInput` —
   * which never read a leave request — handed the day to
   * `statusForMissingAttendance`, whose deliberate default for a working day is
   * `ABSENT`. So an approved, paid day off was docked from the salary *and*
   * spent from the balance. Nobody had taken leave on this instance yet, which
   * is the only reason it never showed up as a wrong payslip.
   *
   * Computed outside the transaction because it reads the calendar and the
   * existing attendance, and neither is being changed here.
   */
  const spanStart = toDateOnly(request.startDate);
  const spanEnd = toDateOnly(request.endDate);
  const span = {
    startDate: spanStart,
    endDate: spanEnd,
    startDayPart: request.startDayPart,
    endDayPart: request.endDayPart,
  };

  const [spanCalendar, existingDays] = await Promise.all([
    nonWorkingDays(ctx.organizationId!, request.employeeId, spanStart, spanEnd),
    prisma.attendanceDay.findMany({
      where: {
        organizationId: ctx.organizationId,
        employeeId: request.employeeId,
        date: { gte: request.startDate, lte: request.endDate },
      },
      select: { id: true, date: true, firstCheckInAt: true, systemStatus: true },
    }),
  ]);

  // "Worked" means a real check-in, not merely a row. A row can exist because
  // an administrator overrode the day, and an override is not attendance.
  const workedDates = new Set(
    existingDays.filter((d) => d.firstCheckInAt !== null).map((d) => toDateOnly(d.date)),
  );

  const leaveDays =
    decision === "APPROVED"
      ? leaveAttendanceDays({
          span,
          chargeableDates: countLeaveDays(span, spanCalendar).chargeableDates,
          paid: request.leaveType.paid,
          weekOff: request.leaveType.isWeekOff,
          workedDates,
        })
      : [];

  await prisma.$transaction(async (tx) => {
    await tx.leaveRequest.update({
      where: { id: requestId },
      data: { status: decision },
    });

    await tx.leaveApproval.updateMany({
      where: { leaveRequestId: requestId, status: "PENDING" },
      data: {
        status: decision === "APPROVED" ? "APPROVED" : "REJECTED",
        approverId: ctx.userId,
        note: note?.trim() || null,
        actedAt: new Date(),
      },
    });

    // The balance moves here and only here.
    if (decision === "APPROVED" && request.leaveType.paid) {
      await tx.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year,
          },
        },
        create: {
          organizationId: ctx.organizationId!,
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          year,
          allocated,
          used: days,
        },
        update: { used: { increment: days } },
      });
    }

    /**
     * Clear whatever this request wrote last time, then write it again.
     *
     * Unconditional rather than only on rejection, so the two branches cannot
     * drift apart and so a second decision on the same request can never leave
     * a stale leave day behind. The direction matters: a row we *created* is
     * deleted, but a row that carries a real check-in is only un-stamped and
     * put back to the status the system worked out for it. Deleting that one
     * would throw away somebody's actual attendance to undo a leave.
     */
    const stamped = await tx.attendanceDay.findMany({
      where: { organizationId: ctx.organizationId, leaveRequestId: requestId },
      select: { id: true, firstCheckInAt: true, systemStatus: true },
    });

    const invented = stamped.filter((d) => d.firstCheckInAt === null).map((d) => d.id);
    if (invented.length > 0) {
      await tx.attendanceDay.deleteMany({ where: { id: { in: invented } } });
    }
    for (const row of stamped) {
      if (row.firstCheckInAt === null) continue;
      await tx.attendanceDay.update({
        where: { id: row.id },
        data: { status: row.systemStatus, leaveRequestId: null, remarks: null },
      });
    }

    for (const day of leaveDays) {
      await tx.attendanceDay.upsert({
        where: {
          employeeId_date: { employeeId: request.employeeId, date: toDate(day.date) },
        },
        create: {
          organizationId: ctx.organizationId!,
          employeeId: request.employeeId,
          date: toDate(day.date),
          status: day.status,
          systemStatus: day.status,
          leaveRequestId: requestId,
          remarks: day.remark,
          source: "SYSTEM",
        },
        // Only the classification moves. Check-in times, worked minutes and
        // lateness belong to attendance and are none of leave's business.
        update: {
          status: day.status,
          leaveRequestId: requestId,
          remarks: day.remark,
        },
      });
    }
  });

  await writeAudit(ctx, {
    action: decision === "APPROVED" ? "leave.approved" : "leave.rejected",
    entityType: "LeaveRequest",
    entityId: requestId,
    before: { status: "PENDING" },
    after: { status: decision, note: note?.trim() || null },
  });

  if (request.employee.userId) {
    await notify.toUser(request.employee.userId, {
      type: decision === "APPROVED" ? "leave.approved" : "leave.rejected",
      title: decision === "APPROVED" ? "Leave approved" : "Leave rejected",
      body:
        decision === "APPROVED"
          ? `Your ${days} day(s) of ${request.leaveType.name} were approved.`
          : `Your ${request.leaveType.name} request was not approved.${note ? ` ${note}` : ""}`,
      link: "/me/leave",
    });
  }

  return { id: requestId, status: decision };
}

/** Withdrawing a request that has not been decided yet. */
export async function cancelLeave(ctx: AuthContext, requestId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "leave.request", "leave");

  const request = await prisma.leaveRequest.findFirst({
    where: { id: requestId, organizationId: ctx.organizationId, employeeId: ctx.employeeId ?? "" },
  });
  if (!request) throw new NotFoundError("That leave request");
  if (request.status !== "PENDING") {
    throw new ConflictError("Only a request that is still pending can be withdrawn.");
  }

  await prisma.leaveRequest.update({
    where: { id: requestId },
    data: { status: "CANCELLED" },
  });

  await writeAudit(ctx, {
    action: "leave.rejected",
    entityType: "LeaveRequest",
    entityId: requestId,
    after: { status: "CANCELLED", by: "employee" },
  });

  return { id: requestId, status: "CANCELLED" as const };
}

export async function listLeaveTypes(ctx: AuthContext) {
  requireOrg(ctx);
  requirePermission(ctx, "leave.request");
  return prisma.leaveType.findMany({
    where: { organizationId: ctx.organizationId, active: true },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      color: true,
      paid: true,
      allowHalfDay: true,
      noticeDays: true,
      maxConsecutive: true,
    },
  });
}
