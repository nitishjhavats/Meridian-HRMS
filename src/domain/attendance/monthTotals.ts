import type { AttendanceStatus } from "./policy";

/**
 * Counting a month of attendance, once.
 *
 * The same eight statuses were tallied in three different places — the admin
 * grid, the CSV report and the payroll engine — with three sets of field names
 * and three chances to disagree about what `EXTRA_DAY` means. This is the
 * decision, extracted, so the grid and the reception screen at least ask the
 * same question. (The payroll engine keeps its own, deliberately: it counts in
 * *payable days* and applies a half-day factor, which is a different question
 * with a different answer.)
 */

/** Days somebody was at work, whatever the reason the day is unusual. */
export const PRESENT_STATUSES: readonly AttendanceStatus[] = [
  "FULL_DAY",
  "EXTRA_DAY",
  "TRAINING_DAY",
  "ON_DUTY",
  // A day in progress is a day somebody is at work. Left out, it fell through
  // to `notMarked`, and the month tile on the day itself read one day short.
  "CHECKED_IN",
];

export const LEAVE_STATUSES: readonly AttendanceStatus[] = ["PAID_LEAVE", "UNPAID_LEAVE"];

export interface MonthTotals {
  present: number;
  absent: number;
  halfDays: number;
  /** Paid and unpaid together, which is what the matrix column shows. */
  leave: number;
  /**
   * And split, because somebody reading their own month needs to know which of
   * their leave cost them money, and the combined figure cannot say.
   */
  paidLeave: number;
  unpaidLeave: number;
  weekOff: number;
  holiday: number;
  lateCount: number;
  notMarked: number;
}

export function emptyMonthTotals(): MonthTotals {
  return {
    present: 0,
    absent: 0,
    halfDays: 0,
    leave: 0,
    paidLeave: 0,
    unpaidLeave: 0,
    weekOff: 0,
    holiday: 0,
    lateCount: 0,
    notMarked: 0,
  };
}

/**
 * Adds one day to a running tally.
 *
 * Mutating, because the callers are building a row a day at a time inside a
 * loop they already have, and returning a fresh object per day would allocate
 * one per employee per day of the month for no benefit.
 */
export function countDay(
  totals: MonthTotals,
  status: AttendanceStatus,
  lateMinutes = 0,
): MonthTotals {
  if (PRESENT_STATUSES.includes(status)) totals.present++;
  else if (status === "HALF_DAY") totals.halfDays++;
  else if (status === "ABSENT") totals.absent++;
  else if (LEAVE_STATUSES.includes(status)) {
    totals.leave++;
    if (status === "PAID_LEAVE") totals.paidLeave++;
    else totals.unpaidLeave++;
  } else if (status === "WEEK_OFF" || status === "DAY_OFF") totals.weekOff++;
  else if (status === "HOLIDAY") totals.holiday++;
  else totals.notMarked++;

  if (lateMinutes > 0) totals.lateCount++;
  return totals;
}

/**
 * Days the organisation expected work on.
 *
 * Not simply "days in the month": a rest day and a holiday were never going to
 * be worked, so counting them as working days makes every attendance figure
 * read worse than it is.
 */
export function workingDays(daysInMonth: number, totals: MonthTotals): number {
  return Math.max(0, daysInMonth - totals.weekOff - totals.holiday);
}

/**
 * How far back a month picker may go.
 *
 * Three months, which is what somebody standing at a reception screen is ever
 * asking about — "was I marked absent in March" — and short enough that the
 * device is not a window onto a year of somebody else's attendance.
 */
export const MONTHS_BACK = 3;

export interface MonthCursor {
  year: number;
  month: number;
}

/** Whether a cursor is inside the window, counted back from `now`. */
export function withinWindow(cursor: MonthCursor, now: MonthCursor): boolean {
  const index = cursor.year * 12 + cursor.month;
  const latest = now.year * 12 + now.month;
  return index <= latest && index >= latest - MONTHS_BACK;
}

/** The cursor `by` months away, normalised. Does not clamp — ask `withinWindow`. */
export function shiftMonth(cursor: MonthCursor, by: number): MonthCursor {
  const index = cursor.year * 12 + (cursor.month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}
