import {
  type DateOnly,
  addDays,
  compare,
  eachDay,
  endOfMonth,
  max as laterOf,
  min as earlierOf,
  monthLabel,
  parts,
  startOfMonth,
} from "../date";
import { isHalfClaimed } from "./attendanceDays";

/**
 * Leave arithmetic.
 *
 * The only interesting question here is "how many days does this request
 * actually cost?", and the answer is never simply end − start: week-offs and
 * holidays inside a leave span are not leave, and a half day at either end is
 * half a day. Getting this wrong overcharges somebody's balance, which is the
 * kind of error people notice and remember.
 */

export type DayPart = "FULL" | "FIRST_HALF" | "SECOND_HALF";

export interface LeaveSpan {
  startDate: DateOnly;
  endDate: DateOnly;
  startDayPart: DayPart;
  endDayPart: DayPart;
}

/** Days the organisation does not expect work on, so they never consume leave. */
export interface NonWorkingDays {
  /** `YYYY-MM-DD` dates that are week-offs. */
  weekOffs: ReadonlySet<string>;
  /** `YYYY-MM-DD` dates that are public holidays. */
  holidays: ReadonlySet<string>;
}

export const NO_NON_WORKING: NonWorkingDays = {
  weekOffs: new Set(),
  holidays: new Set(),
};

export interface CountedLeave {
  /** Chargeable days, in halves. */
  totalDays: number;
  /** Dates that actually consume leave. */
  chargeableDates: DateOnly[];
  /** Dates skipped, and why — shown so nobody has to guess at the total. */
  skipped: { date: DateOnly; reason: "WEEK_OFF" | "HOLIDAY" }[];
}

export function countLeaveDays(span: LeaveSpan, calendar: NonWorkingDays = NO_NON_WORKING): CountedLeave {
  const chargeableDates: DateOnly[] = [];
  const skipped: CountedLeave["skipped"] = [];

  for (const date of eachDay(span.startDate, span.endDate)) {
    if (calendar.holidays.has(date)) {
      skipped.push({ date, reason: "HOLIDAY" });
      continue;
    }
    if (calendar.weekOffs.has(date)) {
      skipped.push({ date, reason: "WEEK_OFF" });
      continue;
    }
    chargeableDates.push(date);
  }

  // The total is the sum of what each chargeable date costs, so that the
  // per-month split below cannot disagree with it: the same weight, per date,
  // is summed either for the whole span or for the slice of it in one month.
  let total = 0;
  for (const date of chargeableDates) total += chargeFor(date, span, chargeableDates);

  return { totalDays: Math.max(0, total), chargeableDates, skipped };
}

/**
 * What one chargeable date costs: a whole day, or half when it is a half-day
 * end.
 *
 * A half day only counts when that end is itself a working day — a request
 * that starts on a Sunday afternoon starts, in practice, on Monday — and a
 * single-day request marked half on both ends is still half a day, not zero.
 * `isHalfClaimed` is the same test the attendance rows are written from; one
 * rule in one place is what keeps a day from being billed as a whole here and
 * half there.
 */
function chargeFor(date: DateOnly, span: LeaveSpan, chargeableDates: readonly DateOnly[]): number {
  return isHalfClaimed(date, { span, chargeableDates }) ? 0.5 : 1;
}

// ------------------------------------------------------------------ by month

/** `YYYY-MM`, the key both sides of the monthly cap are counted under. */
export function monthKey(date: DateOnly): string {
  return date.slice(0, 7);
}

/**
 * A request's chargeable days, by the calendar month each falls in.
 *
 * A monthly cap is a fact about months and a request is not: one from the
 * 30th to the 2nd puts some of its days in each, and charging the whole of it
 * to the month it starts in would let a bank of rest days be spent eight in
 * one month by starting the request on the last day of the one before. Half
 * days go to the month their end lands in, which is why these figures always
 * add up to `totalDays`.
 */
export function chargeableDaysByMonth(span: LeaveSpan, counted: CountedLeave): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const date of counted.chargeableDates) {
    const key = monthKey(date);
    byMonth.set(key, (byMonth.get(key) ?? 0) + chargeFor(date, span, counted.chargeableDates));
  }
  return byMonth;
}

/**
 * The slice of a booked span that falls inside one month, or null when none of
 * it does.
 *
 * A half-day end stays a half-day end only when that end is inside the month.
 * Clip the 31st–2nd request to March and its start half survives while its
 * end, now the 31st, is a whole day — exactly what `countLeaveDays` will then
 * charge for that slice, and the same rule the request itself is measured by.
 */
export function clipSpanToMonth(span: LeaveSpan, year: number, month: number): LeaveSpan | null {
  const first = startOfMonth(year, month);
  const last = endOfMonth(year, month);
  if (compare(span.endDate, first) < 0 || compare(span.startDate, last) > 0) return null;

  const startsInside = compare(span.startDate, first) >= 0;
  const endsInside = compare(span.endDate, last) <= 0;
  return {
    startDate: laterOf(span.startDate, first),
    endDate: earlierOf(span.endDate, last),
    startDayPart: startsInside ? span.startDayPart : "FULL",
    endDayPart: endsInside ? span.endDayPart : "FULL",
  };
}

/**
 * Days already booked of one leave type, by month, from the requests that touch
 * those months.
 *
 * Each request is clipped to the month and charged against the same calendar
 * the new request is, so a booked span straddling a month end counts only the
 * days it actually puts there, and a rest day inside it is not counted twice
 * over. Keyed by `YYYY-MM`, so a month nothing touches is simply absent.
 */
export function bookedDaysByMonth(
  booked: readonly LeaveSpan[],
  months: readonly string[],
  calendar: NonWorkingDays = NO_NON_WORKING,
): Record<string, number> {
  const taken: Record<string, number> = {};
  for (const key of months) {
    const { year, month } = parts(`${key}-01`);
    let days = 0;
    for (const span of booked) {
      const slice = clipSpanToMonth(span, year, month);
      if (slice) days += countLeaveDays(slice, calendar).totalDays;
    }
    taken[key] = days;
  }
  return taken;
}

// ------------------------------------------------------------------ balances

export interface LeaveBalanceState {
  allocated: number;
  accrued: number;
  used: number;
  carriedForward: number;
  encashed: number;
}

/**
 * What is left to take.
 *
 * Accrual-based types grant days as the year passes, so the usable figure is
 * what has accrued plus what was carried forward — not the full annual
 * allocation, which is not earned yet.
 */
export function availableDays(balance: LeaveBalanceState, accrues: boolean): number {
  const granted = accrues ? balance.accrued : balance.allocated;
  return round2(granted + balance.carriedForward - balance.used - balance.encashed);
}

export interface AccrualInput {
  annualAllocation: number;
  monthlyAccrual: number;
  accrualMode: "ANNUAL" | "MONTHLY" | "NONE";
  /** Months of the year the employee has actually been employed for. */
  monthsWorked: number;
}

export function accruedSoFar(input: AccrualInput): number {
  switch (input.accrualMode) {
    case "NONE":
      return 0;
    case "ANNUAL":
      return round2(input.annualAllocation);
    case "MONTHLY":
      // Never more than the annual figure, however many months are counted.
      return round2(Math.min(input.annualAllocation, input.monthlyAccrual * input.monthsWorked));
  }
}

/**
 * Months of `year` somebody was employed for.
 *
 * The figure `accruedSoFar` is asked for, in one place so that the employee's
 * own leave screen, the administrator's balance grid, the year-end run and a
 * full-and-final settlement cannot each work it out slightly differently.
 * Nobody has worked a month of a year that has not started, and nobody worked a
 * year they joined after.
 */
export function monthsWorkedInYear(
  year: number,
  joined: DateOnly | null,
  asOf: DateOnly,
): number {
  const from = joined ?? `${year}-01-01`;
  const joinedYear = Number(from.slice(0, 4));
  const asOfYear = Number(asOf.slice(0, 4));
  if (joinedYear > year || year > asOfYear) return 0;

  const startMonth = joinedYear === year ? Number(from.slice(5, 7)) : 1;
  const lastMonth = asOfYear === year ? Number(asOf.slice(5, 7)) : 12;
  return Math.max(0, lastMonth - startMonth + 1);
}

/**
 * Days accrued for a stored balance row.
 *
 * `LeaveBalance.accrued` is a column nothing in the product ever recomputes. A
 * row is created by the first approval of the year, by the year-end
 * carry-forward run, or by an adjustment — and whatever the column held at that
 * moment is what it still holds in December. For a MONTHLY type that is wrong by
 * construction: what has accrued is a function of months worked, not of the day
 * a row happened to appear. Reading it back through here is what stops a row
 * created on the 1st of January pinning somebody's earned leave at zero for the
 * whole year.
 *
 * `Math.max` rather than a straight recomputation, so a deliberately generous
 * opening figure — an agreed joining balance, a migration — is never quietly cut
 * back by the arithmetic. `null` means there is no row at all, which is the case
 * every reader already handled by computing the figure outright.
 */
export function accruedForRow(stored: number | null, input: AccrualInput): number {
  if (stored === null) return accruedSoFar(input);
  if (input.accrualMode !== "MONTHLY") return round2(stored);
  return Math.max(round2(stored), accruedSoFar(input));
}

/** Carry-forward at year end, capped by the type's own limit. */
export function carryForwardAmount(
  balance: LeaveBalanceState,
  accrues: boolean,
  allowed: boolean,
  maxCarryForward: number,
): number {
  if (!allowed) return 0;
  const unused = availableDays(balance, accrues);
  return round2(Math.max(0, Math.min(unused, maxCarryForward)));
}

// ------------------------------------------------------------------ validation

export type LeaveProblemCode =
  | "END_BEFORE_START"
  | "ZERO_DAYS"
  | "INSUFFICIENT_BALANCE"
  | "TOO_LONG"
  | "TOO_LATE"
  | "HALF_DAY_NOT_ALLOWED"
  | "OVERLAPS_EXISTING"
  | "TOO_MANY_THIS_MONTH";

export interface LeaveProblem {
  code: LeaveProblemCode;
  message: string;
}

export interface LeaveRules {
  allowHalfDay: boolean;
  maxConsecutive: number | null;
  noticeDays: number;
  paid: boolean;
}

/**
 * The cap on a type in any one calendar month, and what is already against it.
 *
 * `taken` is by `YYYY-MM`, clipped to that month (see `bookedDaysByMonth`),
 * and counts pending as well as approved: a pending request is a claim on the
 * month the way it is a claim on the balance, and a cap that only counted
 * approvals would let somebody queue eight and see which ones get through.
 */
export interface MonthlyCap {
  /** `LeaveType.maxPerMonth`. */
  cap: number;
  taken: Readonly<Record<string, number>>;
}

export interface ValidateLeaveInput {
  span: LeaveSpan;
  counted: CountedLeave;
  rules: LeaveRules;
  available: number;
  /** Today, for the notice-period check. */
  today: DateOnly;
  /** Spans already booked, to catch double-booking. */
  existing: { startDate: DateOnly; endDate: DateOnly }[];
  /** Absent, or null, when the type has no monthly cap. */
  monthly?: MonthlyCap | null;
}

/**
 * Every reason a request cannot stand, together.
 *
 * Returning all of them at once matters: fixing one problem only to be told
 * about the next is the interaction people abandon.
 */
export function validateLeave(input: ValidateLeaveInput): LeaveProblem[] {
  const problems: LeaveProblem[] = [];
  const { span, counted, rules } = input;

  if (compare(span.endDate, span.startDate) < 0) {
    problems.push({ code: "END_BEFORE_START", message: "The last day is before the first day." });
    return problems;
  }

  if (counted.totalDays <= 0) {
    problems.push({
      code: "ZERO_DAYS",
      message:
        counted.skipped.length > 0
          ? "Every day in that range is a week-off or holiday, so there is no leave to take."
          : "That request covers no days.",
    });
  }

  if (!rules.allowHalfDay && (span.startDayPart !== "FULL" || span.endDayPart !== "FULL")) {
    problems.push({
      code: "HALF_DAY_NOT_ALLOWED",
      message: "This leave type must be taken as whole days.",
    });
  }

  // Checked before the balance: a pending request is usually the reason the
  // balance looks short, and "you already booked those days" is the fact that
  // actually helps.
  for (const other of input.existing) {
    if (
      compare(span.startDate, other.endDate) <= 0 &&
      compare(span.endDate, other.startDate) >= 0
    ) {
      problems.push({
        code: "OVERLAPS_EXISTING",
        message: `You already have leave booked between ${other.startDate} and ${other.endDate}.`,
      });
      break;
    }
  }

  // Unpaid leave has no balance to run out of.
  if (rules.paid && counted.totalDays > input.available) {
    problems.push({
      code: "INSUFFICIENT_BALANCE",
      message: `You have ${input.available} day(s) left and this request needs ${counted.totalDays}.`,
    });
  }

  if (rules.maxConsecutive != null && counted.totalDays > rules.maxConsecutive) {
    problems.push({
      code: "TOO_LONG",
      message: `This leave type allows at most ${rules.maxConsecutive} consecutive day(s).`,
    });
  }

  // Month by month, because a request can straddle two: each month is held to
  // the cap on its own, with only the days that actually land in it. One
  // sentence is enough — the first month that overflows is the one to fix.
  if (input.monthly) {
    const { cap, taken } = input.monthly;
    for (const [key, requested] of chargeableDaysByMonth(span, counted)) {
      const already = taken[key] ?? 0;
      if (already + requested <= cap) continue;
      const { year, month } = parts(`${key}-01`);
      const left = Math.max(0, round2(cap - already));
      problems.push({
        code: "TOO_MANY_THIS_MONTH",
        message: `This leave type allows at most ${cap} day(s) a month; ${already} already booked in ${monthLabel(year, month)} leaves ${left}, and this request needs ${requested} there.`,
      });
      break;
    }
  }

  if (rules.noticeDays > 0) {
    const earliest = addDays(input.today, rules.noticeDays);
    if (compare(span.startDate, earliest) < 0) {
      problems.push({
        code: "TOO_LATE",
        message: `This leave type needs ${rules.noticeDays} day(s) notice, so the earliest start is ${earliest}.`,
      });
    }
  }

  return problems;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
