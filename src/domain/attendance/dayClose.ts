/**
 * When a day is over, and what is left of it.
 *
 * Nothing closed a day before this. A person who checked in and never
 * checked out was scored the moment they arrived (see `CHECKED_IN`), and a
 * person who never came was nothing at all -- no row, a blank cell, "not
 * marked" in every total -- while payroll quietly counted the same blank as
 * absent. So the grid said one thing and the payslip another, and the owner
 * filled the blanks in by hand.
 *
 * These are the pure parts: which dates are old enough to close, whether a
 * given date's marking window has passed in the organisation's own zone, who
 * was on the roll that day, and what an open row settles to. The service that
 * reads the database and writes the rows is `services/attendance/dayClose.ts`.
 */

import { type DateOnly, addDays, compare, eachDay, zonedTimeToInstant } from "../date";
import type { DayKind } from "../calendar";
import {
  type AttendancePolicy,
  type DayEvaluation,
  evaluateDay,
  markingWindow,
} from "./policy";

/**
 * How far back a run looks.
 *
 * The close runs once a night, at 03:00 in the container's clock (IST).
 * Seven days means a missed night -- a cron that quietly stopped, a
 * container that was restarting -- is caught up on the next one, and a shift
 * whose window is still open at 03:00 (an evening shift ending after 22:00)
 * is closed the following night rather than never.
 */
export const DAY_CLOSE_LOOKBACK_DAYS = 7;

/**
 * The first date the nightly close may touch on its own.
 *
 * The owner chose no back-fill: the day the close shipped is the first day it
 * closes, and the blank working days before it stay blank unless an operator
 * runs `close-attendance-days --from` after reading the dry run with them.
 * Without this, the first night after the deploy would have been an
 * unreviewed seven-day back-fill for every organisation.
 */
export const DAY_CLOSE_EPOCH: DateOnly = "2026-09-18";

export const NO_CHECK_IN_REMARK = "No check-in recorded";
export const NO_CHECK_OUT_REMARK = "No check-out recorded";

/**
 * Every date from `from` (or `today - lookback`, never before the epoch) up
 * to and including `today`, oldest first. An explicit `from` may reach back
 * before the epoch: that is the operator's back-fill, asked for by name.
 */
export function closableDates(input: {
  today: DateOnly;
  from?: DateOnly;
  lookbackDays?: number;
}): DateOnly[] {
  const lookback = input.lookbackDays ?? DAY_CLOSE_LOOKBACK_DAYS;
  const earliest = addDays(input.today, -lookback);
  const floor = input.from ?? DAY_CLOSE_EPOCH;
  const start = compare(floor, earliest) > 0 ? floor : earliest;
  if (compare(start, input.today) > 0) return [];
  return eachDay(start, input.today);
}

/**
 * The instant after which nobody can mark this date any more.
 *
 * `markingWindow` answers on the shift's own extended axis -- a 22:00-06:00
 * shift with a five-hour close reaches 11:00 the next morning as minute 1980
 * of the shift's day -- and `zonedTimeToInstant` turns that into a real
 * instant, so a date is never closed while somebody could still check out
 * of it.
 */
export function windowClosedAt(
  date: DateOnly,
  rules: Pick<AttendancePolicy, "shift" | "checkInWindow">,
  timeZone: string,
): Date {
  return zonedTimeToInstant(date, markingWindow(rules).closesAt, timeZone);
}

export function isDateClosed(
  date: DateOnly,
  rules: Pick<AttendancePolicy, "shift" | "checkInWindow">,
  timeZone: string,
  now: Date,
): boolean {
  return now.getTime() >= windowClosedAt(date, rules, timeZone).getTime();
}

/** On the roll from the joining date through the exit date, both inclusive. */
export function isOnRoll(
  employee: { joiningDate: DateOnly; exitDate: DateOnly | null },
  date: DateOnly,
): boolean {
  if (compare(date, employee.joiningDate) < 0) return false;
  if (employee.exitDate && compare(date, employee.exitDate) > 0) return false;
  return true;
}

/**
 * What an open row becomes once the day has closed.
 *
 * The same `evaluateDay` a check-out would have run, without `open`, so the
 * close and `record.ts` cannot drift apart: the missing-checkout rule, the
 * late-arrival rule and the rest-day extra-day rule all apply exactly as they
 * would have at a check-out that never came.
 */
export function settleOpenRow(
  row: { dayKind: DayKind; checkInMinutes: number; training: boolean },
  rules: AttendancePolicy,
): DayEvaluation {
  return evaluateDay(
    {
      dayKind: row.dayKind,
      checkInMinutes: row.checkInMinutes,
      checkOutMinutes: null,
      training: row.training,
    },
    rules,
  );
}
