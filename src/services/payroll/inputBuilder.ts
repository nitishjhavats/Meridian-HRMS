import type { Prisma, PrismaClient } from "@prisma/client";
import {
  type DateOnly,
  endOfMonth,
  makeDate,
  parts,
  startOfMonth,
} from "@/domain/date";
import {
  buildPeriodCalendar,
  type DayKind,
  type HolidayEntry,
  type WeeklyOffConfig,
} from "@/domain/calendar";
import { leaveAttendanceDaysForMissingRows } from "@/domain/leave/attendanceDays";
import {
  DEFAULT_ATTENDANCE_POLICY,
  settleOpenDay,
  type AttendancePolicy,
} from "@/domain/attendance/policy";
import { resolveWeeklyOff } from "@/services/org/weeklyOff";
import type {
  AdjustmentInput,
  AdvanceInput,
  AdvanceRecoveryMode,
  DayLedgerEntry,
  EmploymentSegment,
  PayrollInput,
  PayrollPolicy,
} from "@/domain/payroll/types";

/**
 * Turns database rows into the pure `PayrollInput` the engine consumes.
 *
 * This is the only place the two worlds meet: everything above it is Prisma,
 * everything below it is framework-free domain code that can be unit-tested
 * without a database. Keeping the seam here is what lets the simulator, the
 * seed script and production payroll all share one calculation.
 */

export interface BuildInputOptions {
  employeeId: string;
  organizationId: string;
  year: number;
  month: number;
  policy: PayrollPolicy;
  /**
   * The run being recalculated, when there is one.
   *
   * Manual adjustments hang off a `PayrollItem`, which only exists once a run
   * has been calculated at least once — so on the first pass there are none, and
   * on every pass after it they have to be fed back in. Without this the
   * adjustments screen wrote rows that the engine never read and no payslip ever
   * reflected: the money simply did not move.
   */
  payrollRunId?: string;
  /**
   * What an open day is worth once nobody is going to check out of it.
   *
   * Defaults to the shipped rule; `calculateRun` always passes the
   * organisation's real one, read for the period being paid. It is here so a
   * `CHECKED_IN` row the day-close never reached is settled the way the close
   * would have settled it, rather than reaching the engine as a status it has
   * no case for.
   */
  missingCheckout?: AttendancePolicy["missingCheckout"];
}

export interface ClaimsRidingRunSelector {
  organizationId: string;
  /** Last day of the period the run pays, e.g. "2026-03-31". */
  periodEnd: DateOnly;
  /** The run doing the paying, when there is one. */
  payrollRunId?: string | null;
}

/**
 * Which reimbursement claims ride a payroll run.
 *
 * Written once because it is read at two moments that have to agree:
 * `buildPayrollInput` asks it what goes *on* the payslip, and
 * `markReimbursementsPaid` asks it at lock time what to stamp PAID. When those
 * two answers differ, either somebody is paid something their payslip does not
 * show, or one claim rides two runs — so the rule lives in one function and the
 * drift is not expressible.
 *
 * Two arms, and both are load-bearing:
 *
 *  - APPROVED and not yet stamped. Earlier periods are included on purpose: a
 *    claim approved after last month's run was locked should ride the next one
 *    rather than never being paid at all.
 *  - PAID by *this* run. Without it, unlocking and recalculating would quietly
 *    drop a reimbursement that had already been agreed and printed. Claims paid
 *    by a *different* run stay excluded, which is what stops the same money
 *    being added to every later run whose period matches.
 *
 * With no run id — a simulation, or a first calculation — only the first arm
 * applies, because there is no run yet whose own payments need preserving.
 */
export function claimsRidingRun(
  selector: ClaimsRidingRunSelector,
): Prisma.ReimbursementClaimWhereInput {
  const { year, month } = parts(selector.periodEnd);
  return {
    organizationId: selector.organizationId,
    AND: [
      {
        OR: [
          { periodYear: { lt: year } },
          { periodYear: year, periodMonth: { lte: month } },
        ],
      },
      {
        OR: [
          { status: "APPROVED", paidInRunId: null },
          ...(selector.payrollRunId
            ? [{ status: "PAID" as const, paidInRunId: selector.payrollRunId }]
            : []),
        ],
      },
    ],
  };
}

/**
 * What a day is worth when attendance never wrote a row for it.
 *
 * Payroll cannot leave a day out of the ledger, so every day the calendar knows
 * about has to be given a status even when nothing was recorded. The *direction*
 * of that default is the invariant: a missing working day is an absence, and a
 * missing rest day is still a rest day. Nothing here may return a status the
 * engine counts as worked — flip it to one and an organisation whose device
 * sync or attendance job quietly stopped writing rows pays everybody in full,
 * with no error anywhere to say so.
 *
 * The fall-through is deliberately ABSENT rather than an exhaustive switch: a
 * day kind nobody has thought about yet should land on the side that costs the
 * employer nothing it has not been told about.
 */
export function statusForMissingAttendance(kind: DayKind): DayLedgerEntry["status"] {
  switch (kind) {
    case "WEEK_OFF":
      return "WEEK_OFF";
    case "HOLIDAY":
      return "HOLIDAY";
    default:
      return "ABSENT";
  }
}

/**
 * How many paid rest days a month this person is owed, as far as the record
 * says.
 *
 * Their own figure, then their designation's. Null is "ask the payroll rule",
 * which the engine does — the policy fallback stays there, so a simulation
 * with no employee behind it and a real run read the same last layer. The
 * sample payslip calls this too, so the two documents cannot disagree about
 * where the number comes from.
 */
export function weekOffQuotaFor(employee: {
  weekOffsPerMonth: number | null;
  designation: { weekOffsPerMonth: number | null } | null;
}): number | null {
  return employee.weekOffsPerMonth ?? employee.designation?.weekOffsPerMonth ?? null;
}

export async function buildPayrollInput(
  db: PrismaClient,
  options: BuildInputOptions,
): Promise<PayrollInput | null> {
  const { employeeId, organizationId, year, month, policy } = options;
  const missingCheckout = options.missingCheckout ?? DEFAULT_ATTENDANCE_POLICY.missingCheckout;

  const periodStart = startOfMonth(year, month);
  const periodEnd = endOfMonth(year, month);

  const employee = await db.employee.findFirst({
    where: { id: employeeId, organizationId },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      joiningDate: true,
      exitDate: true,
      departmentId: true,
      employmentState: true,
      weekOffsPerMonth: true,
      designation: { select: { weekOffsPerMonth: true } },
      weeklyOffConfig: true,
      weeklyOffPattern: { select: { config: true } },
      trainingPlans: {
        select: {
          startDate: true,
          endDate: true,
          mode: true,
          percent: true,
          fixedAmountPaise: true,
          postTrainingCtcPaise: true,
        },
      },
    },
  });
  if (!employee) return null;

  const joinedOn = toDateOnly(employee.joiningDate);
  const exitOn = employee.exitDate ? toDateOnly(employee.exitDate) : null;

  // Nobody is paid for a month they were not on the rolls in.
  if (joinedOn > periodEnd) return null;
  if (exitOn && exitOn < periodStart) return null;

  const onRollFrom = joinedOn > periodStart ? joinedOn : periodStart;
  const onRollTo = exitOn && exitOn < periodEnd ? exitOn : periodEnd;

  const [
    salaryProfile,
    holidays,
    attendance,
    advances,
    claims,
    manualAdjustments,
    approvedLeave,
  ] = await Promise.all([
    db.salaryProfile.findFirst({
      // `organizationId` as well as `employeeId`, even though the caller has
      // already resolved the employee through a tenant-filtered query. An
      // unqualified `where` on a money table is the one shape the house rule
      // forbids outright, because it is the line a later refactor makes
      // reachable — and what it selects here is somebody's salary.
      where: {
        organizationId,
        employeeId,
        effectiveFrom: { lte: new Date(`${periodEnd}T00:00:00Z`) },
      },
      orderBy: { effectiveFrom: "desc" },
      select: { ctcMonthlyPaise: true, structure: true },
    }),
    db.holiday.findMany({
      where: {
        organizationId,
        date: { gte: new Date(`${periodStart}T00:00:00Z`), lte: new Date(`${periodEnd}T00:00:00Z`) },
      },
      select: {
        id: true,
        name: true,
        date: true,
        paid: true,
        optional: true,
        departmentIds: true,
        employeeIds: true,
        regions: true,
      },
    }),
    db.attendanceDay.findMany({
      where: {
        employeeId,
        date: { gte: new Date(`${periodStart}T00:00:00Z`), lte: new Date(`${periodEnd}T00:00:00Z`) },
      },
      select: {
        date: true,
        status: true,
        lateMinutes: true,
        earlyLeaveMinutes: true,
        overtimeMinutes: true,
      },
      orderBy: { date: "asc" },
    }),
    db.salaryAdvance.findMany({
      where: { employeeId, status: "ACTIVE" },
      select: {
        id: true,
        amountPaise: true,
        recoveredPaise: true,
        recovery: true,
        recoveries: { select: { id: true } },
      },
      orderBy: { issuedOn: "asc" },
    }),
    // What this payslip shows as reimbursed. `markReimbursementsPaid` decides
    // what to stamp at lock from the same predicate, so the payslip and the
    // stamping cannot answer differently.
    db.reimbursementClaim.findMany({
      where: {
        employeeId,
        ...claimsRidingRun({ organizationId, periodEnd, payrollRunId: options.payrollRunId }),
      },
      select: { id: true, claimNumber: true, title: true, approvedPaise: true },
    }),
    // Adjustments an administrator added to this employee's line on this run.
    // Scoped through the item's own run so an adjustment cannot be pulled in
    // from a different month.
    options.payrollRunId
      ? db.payrollAdjustment.findMany({
          where: {
            organizationId,
            payrollRunId: options.payrollRunId,
            employeeId,
          },
          select: { code: true, label: true, kind: true, amountPaise: true, reason: true },
        })
      : Promise.resolve([]),
    /**
     * Approved leave overlapping this period — the safety net under the
     * attendance rows.
     *
     * `decideLeave` now writes an `AttendanceDay` for every leave day, so in
     * the ordinary case this finds nothing new. It earns its place in the two
     * cases where that row is not there: leave approved before that was written,
     * and a row an administrator deleted afterwards. Without it those days fall
     * to `statusForMissingAttendance`, which calls a working day `ABSENT` — and
     * a day off that was approved and already deducted from the balance would
     * be docked from the salary as well.
     */
    db.leaveRequest.findMany({
      where: {
        organizationId,
        employeeId,
        status: "APPROVED",
        startDate: { lte: new Date(`${periodEnd}T00:00:00Z`) },
        endDate: { gte: new Date(`${periodStart}T00:00:00Z`) },
      },
      select: {
        startDate: true,
        endDate: true,
        startDayPart: true,
        endDayPart: true,
        leaveType: { select: { paid: true, isWeekOff: true } },
      },
      orderBy: { startDate: "asc" },
    }),
  ]);

  const ctc = salaryProfile?.ctcMonthlyPaise ?? 0;

  // One query per employee in a run. Payroll is not a hot path and a wrong
  // rest-day costs somebody a day's pay, so the trade is the right way round.
  const weeklyOff = await resolveWeeklyOff(db, organizationId, employee);

  const calendar = buildPeriodCalendar(
    periodStart,
    periodEnd,
    {
      employeeId,
      departmentId: employee.departmentId,
      region: null,
      weeklyOff,
    },
    holidays.map(
      (h): HolidayEntry => ({
        id: h.id,
        name: h.name,
        date: toDateOnly(h.date),
        paid: h.paid,
        optional: h.optional,
        departmentIds: h.departmentIds,
        employeeIds: h.employeeIds,
        regions: h.regions,
      }),
    ),
  );

  // The ledger must cover exactly the days the employee was on the rolls; days
  // outside that window are simply absent from it, which is what prorates a
  // mid-month joiner correctly.
  const byDate = new Map(attendance.map((a) => [toDateOnly(a.date), a]));

  /**
   * Days approved leave accounts for, for the ones attendance never wrote.
   *
   * Built from the same pure decision `decideLeave` uses, so the safety net and
   * the record cannot classify the same day differently. Only working days are
   * offered to it — a leave spanning a Sunday must not turn that Sunday into a
   * leave day and charge somebody for it, which is exactly what `countLeaveDays`
   * refuses to do on the other side.
   */
  const workingDates = new Set(
    calendar.days.filter((d) => d.kind === "WORKING").map((d) => d.date),
  );
  const leaveByDate = new Map<DateOnly, DayLedgerEntry["status"]>();
  for (const request of approvedLeave) {
    const span = {
      startDate: toDateOnly(request.startDate),
      endDate: toDateOnly(request.endDate),
      startDayPart: request.startDayPart,
      endDayPart: request.endDayPart,
    };
    const chargeableDates = calendar.days
      .filter((d) => d.kind === "WORKING" && d.date >= span.startDate && d.date <= span.endDate)
      .map((d) => d.date);
    if (chargeableDates.length === 0) continue;

    for (const row of leaveAttendanceDaysForMissingRows({
      span,
      chargeableDates,
      paid: request.leaveType.paid,
      weekOff: request.leaveType.isWeekOff,
    })) {
      if (workingDates.has(row.date)) leaveByDate.set(row.date, row.status);
    }
  }

  const ledger: DayLedgerEntry[] = [];

  for (const day of calendar.days) {
    if (day.date < onRollFrom || day.date > onRollTo) continue;
    const record = byDate.get(day.date);

    if (record) {
      ledger.push({
        date: day.date,
        // The ledger never carries CHECKED_IN. A row stays that way when the
        // close misses a night, or a run is calculated mid-day, and the engine
        // has no case for it: carried through, the day counts as nothing --
        // not worked, not absent -- so the half day the organisation's rule
        // owes is paid as nothing and an IGNORE day loses its full pay. Settle
        // it here, the same way the close would -- with the day's kind, so a
        // check-in on a week off or a holiday settles to the extra day the
        // close would make of it rather than to a working-day half day.
        status: settleOpenDay(record.status, missingCheckout, day.kind),
        lateMinutes: record.lateMinutes,
        earlyLeaveMinutes: record.earlyLeaveMinutes,
        overtimeMinutes: record.overtimeMinutes,
        isLate: record.lateMinutes > 0,
      });
      continue;
    }

    // No attendance row. Approved leave answers for the day before the
    // calendar's default does, because that default is `ABSENT`.
    ledger.push({
      date: day.date,
      status: leaveByDate.get(day.date) ?? statusForMissingAttendance(day.kind),
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      overtimeMinutes: 0,
      isLate: false,
    });
  }

  return {
    // The person's own quota first, then their designation's. `?? null` rather
    // than leaving it undefined, so "no designation" and "a designation that
    // sets nothing" reach the engine as the same answer: ask the payroll rule.
    weekOffQuota: weekOffQuotaFor(employee),
    employee: {
      id: employee.id,
      code: employee.employeeCode,
      name: [employee.firstName, employee.lastName].filter(Boolean).join(" "),
      joinedOn,
      exitOn,
    },
    period: { year, month, start: periodStart, end: periodEnd },
    ctcMonthlyPaise: ctc,
    segments: buildSegments(employee, ctc, periodStart, periodEnd, policy),
    calendar: {
      totalDays: calendar.totalDays,
      workingDays: calendar.workingDays,
      weekOffDays: calendar.weekOffDays,
      holidayDays: calendar.holidayDays,
      paidHolidayDays: calendar.paidHolidayDays,
    },
    ledger,
    advances: advances.map(
      (a): AdvanceInput => ({
        id: a.id,
        outstandingPaise: a.amountPaise - a.recoveredPaise,
        originalAmountPaise: a.amountPaise,
        installmentsPaid: a.recoveries.length,
        recovery: (a.recovery as AdvanceRecoveryMode | null) ?? policy.advance.defaultMode,
      }),
    ),
    adjustments: [
      ...claims.map(
        (claim): AdjustmentInput => ({
          code: `REIMB_${claim.claimNumber}`,
          label: claim.title,
          kind: "EARNING",
          amountPaise: claim.approvedPaise,
          reason: "Approved reimbursement claim",
        }),
      ),
      ...manualAdjustments.map(
        (adjustment): AdjustmentInput => ({
          code: adjustment.code,
          label: adjustment.label,
          kind: adjustment.kind,
          amountPaise: adjustment.amountPaise,
          reason: adjustment.reason ?? "Manual adjustment",
        }),
      ),
    ],
    componentOverrides: null,
  };
}

/**
 * Splits the period into employment segments so training and regular pay can
 * apply to different parts of the same month.
 */
function buildSegments(
  employee: {
    employmentState: string;
    trainingPlans: {
      startDate: Date;
      endDate: Date;
      mode: string;
      percent: unknown;
      fixedAmountPaise: number | null;
      postTrainingCtcPaise: number | null;
    }[];
  },
  ctc: number,
  periodStart: DateOnly,
  periodEnd: DateOnly,
  policy: PayrollPolicy,
): EmploymentSegment[] {
  const plan = employee.trainingPlans
    .map((p) => ({ ...p, from: toDateOnly(p.startDate), to: toDateOnly(p.endDate) }))
    .filter((p) => p.from <= periodEnd && p.to >= periodStart)
    .sort((a, b) => (a.from < b.from ? -1 : 1))[0];

  if (!plan) {
    return [
      {
        from: periodStart,
        to: periodEnd,
        state: normaliseState(employee.employmentState),
        ctcMonthlyPaise: ctc,
      },
    ];
  }

  const trainingFrom = plan.from > periodStart ? plan.from : periodStart;
  const trainingTo = plan.to < periodEnd ? plan.to : periodEnd;

  const training: EmploymentSegment = {
    from: trainingFrom,
    to: trainingTo,
    state: "TRAINING",
    ctcMonthlyPaise: ctc,
    training: {
      mode: (plan.mode as "PERCENT" | "FIXED" | "UNPAID") ?? policy.training.defaultMode,
      percent: plan.percent != null ? Number(plan.percent) : policy.training.defaultPercent,
      ...(plan.fixedAmountPaise != null ? { fixedAmountPaise: plan.fixedAmountPaise } : {}),
    },
  };

  const segments: EmploymentSegment[] = [training];

  // Training ended part-way through the month: the rest of it is paid normally.
  if (trainingTo < periodEnd) {
    segments.push({
      from: nextDay(trainingTo),
      to: periodEnd,
      state: "REGULAR",
      ctcMonthlyPaise: plan.postTrainingCtcPaise ?? ctc,
    });
  }
  if (trainingFrom > periodStart) {
    segments.unshift({
      from: periodStart,
      to: previousDay(trainingFrom),
      state: "REGULAR",
      ctcMonthlyPaise: ctc,
    });
  }

  return segments;
}

function normaliseState(state: string): EmploymentSegment["state"] {
  switch (state) {
    case "TRAINING":
    case "PROBATION":
    case "CONFIRMED":
    case "NOTICE_PERIOD":
      return state;
    default:
      return "REGULAR";
  }
}

export function toDateOnly(date: Date): DateOnly {
  return makeDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function nextDay(date: DateOnly): DateOnly {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function previousDay(date: DateOnly): DateOnly {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
