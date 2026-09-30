import type { AttendanceStatus } from "../attendance/policy";
import type { DateOnly } from "../date";
import type { DayPart, LeaveSpan } from "./index";

/**
 * What an approved leave means to the day it covers.
 *
 * This exists because approving leave used to mean nothing at all to payroll.
 * `decideLeave` wrote `LeaveRequest.status` and `LeaveBalance.used` and stopped;
 * `buildPayrollInput` never read a leave request; and a working day with no
 * attendance row is defaulted to `ABSENT`. So an approved, paid leave day was
 * paid as an absence *and* spent the balance — charged twice for one day off.
 *
 * The decision is here, pure, because it is a table of seven cases and two of
 * them are the ones that will be argued about later. Both callers ask this
 * function rather than each deciding for itself.
 *
 * | half? | already worked? | paid type? | the day becomes |
 * |-------|-----------------|------------|-----------------|
 * | no    | yes             | either     | nothing — presence beats the claim |
 * | no    | no              | yes        | `PAID_LEAVE`    |
 * | no    | no              | no         | `UNPAID_LEAVE`  |
 * | yes   | yes             | yes        | `FULL_DAY` — half worked plus half paid leave is a whole day |
 * | yes   | yes             | no         | `HALF_DAY` — half worked, the other half at their own cost |
 * | yes   | no              | yes        | `HALF_DAY` — half is paid leave, half is simply missing |
 * | yes   | no              | no         | `ABSENT` — neither half is owed |
 *
 * "Presence beats the claim" is not a new rule. `evaluateDay` already says it
 * (`if (input.leave && !hasIn)`), and it is the safe direction: somebody who
 * booked a day off and then came in should be paid for coming in, and an
 * organisation should never find a leave row quietly erasing a real check-in.
 *
 * Week-offs and holidays never appear here. `countLeaveDays` has already
 * removed them into `skipped`, which is why this takes `chargeableDates` rather
 * than a start and an end — a leave that spans a Sunday must not turn that
 * Sunday into a leave day and bill somebody for it.
 */

export interface LeaveDayRecord {
  date: DateOnly;
  status: AttendanceStatus;
  /** Why the day reads the way it does, for the attendance screen and the audit. */
  remark: string;
}

export interface LeaveDayInput {
  span: Pick<LeaveSpan, "startDate" | "endDate" | "startDayPart" | "endDayPart">;
  /** From `countLeaveDays`: the dates that actually consume leave, in order. */
  chargeableDates: readonly DateOnly[];
  /** `LeaveType.paid`. */
  paid: boolean;
  /**
   * `LeaveType.isWeekOff` — the weekly rest day, booked as a request.
   *
   * It writes `WEEK_OFF` rather than `PAID_LEAVE`, and that single difference
   * is what links leave to payroll: the engine counts `weekOffDays`, the
   * week-off quota is measured against that count, and the rule that pays for
   * rest days somebody did not get to take reads the shortfall from it. Write
   * `PAID_LEAVE` here instead and a booked rest day would be paid leave in
   * payroll, spend a leave balance, and never count towards the quota.
   */
  weekOff?: boolean;
  /** Dates that already carry a real check-in. */
  workedDates?: ReadonlySet<string>;
}

/**
 * Whether a chargeable date is only half claimed.
 *
 * A half day counts at an end only when that end is itself chargeable — a
 * request that starts on a Sunday afternoon starts, in practice, on Monday, and
 * `countLeaveDays` applies exactly the same test when it works out the total.
 * The two must agree: a day billed as a whole here and half there is a day
 * somebody is paid for twice or not at all.
 */
export function isHalfClaimed(
  date: DateOnly,
  input: Pick<LeaveDayInput, "span" | "chargeableDates">,
): boolean {
  const { span, chargeableDates } = input;
  const first = chargeableDates[0];
  const last = chargeableDates[chargeableDates.length - 1];

  const halfAtStart = date === first && first === span.startDate && span.startDayPart !== "FULL";
  const halfAtEnd = date === last && last === span.endDate && span.endDayPart !== "FULL";

  return halfAtStart || halfAtEnd;
}

/**
 * The attendance rows an approved leave should produce.
 *
 * Days that produce nothing are absent from the result rather than present with
 * a null status, so a caller cannot accidentally write one.
 */
export function leaveAttendanceDays(input: LeaveDayInput): LeaveDayRecord[] {
  const worked = input.workedDates ?? new Set<string>();
  const rows: LeaveDayRecord[] = [];

  for (const date of input.chargeableDates) {
    const half = isHalfClaimed(date, input);
    const attended = worked.has(date);

    if (!half) {
      // Presence beats the claim. Nothing is written, and nothing is removed.
      if (attended) continue;
      if (input.weekOff) {
        rows.push({ date, status: "WEEK_OFF", remark: "Weekly off" });
        continue;
      }
      rows.push({
        date,
        status: input.paid ? "PAID_LEAVE" : "UNPAID_LEAVE",
        remark: input.paid ? "Approved paid leave" : "Approved unpaid leave",
      });
      continue;
    }

    if (attended) {
      rows.push(
        input.paid
          ? { date, status: "FULL_DAY", remark: "Half day worked, half day paid leave" }
          : { date, status: "HALF_DAY", remark: "Half day worked, half day unpaid leave" },
      );
      continue;
    }

    rows.push(
      input.paid
        ? { date, status: "HALF_DAY", remark: "Half day paid leave, half day not worked" }
        : { date, status: "ABSENT", remark: "Half day unpaid leave, half day not worked" },
    );
  }

  return rows;
}

/**
 * The same decision for the payroll read path, where there is never a check-in.
 *
 * `buildPayrollInput` only asks about days that have **no** attendance row at
 * all, so `workedDates` is empty by construction. Kept as its own name so the
 * caller reads as what it is, and so a later change cannot quietly start
 * passing worked days through a path that assumes there are none.
 */
export function leaveAttendanceDaysForMissingRows(
  input: Omit<LeaveDayInput, "workedDates">,
): LeaveDayRecord[] {
  return leaveAttendanceDays({ ...input, workedDates: new Set() });
}

/** Re-exported so a caller does not have to reach into the leave index for it. */
export type { DayPart };
