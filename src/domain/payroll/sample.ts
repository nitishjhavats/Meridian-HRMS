import { type DateOnly, parts } from "../date";
import type { SimulationInput } from "./simulate";

/**
 * The month a sample payslip describes.
 *
 * An employee who has never been paid has no payslip to look at, and the only
 * sample in the product was the admin one built from round figures — ₹30,000
 * basic for everybody, whatever they actually earn. So the question "what will
 * my payslip look like" had no answer for the person who most wanted one.
 *
 * This decides the *shape of the month* and nothing else: the arithmetic is
 * `simulatePayroll` over the real engine, with the organisation's own policy and
 * the employee's own CTC. Keeping the shape here, pure, is what lets it be
 * pinned — because the shape is the whole claim the document makes.
 *
 * Three decisions, and each is the reason the figures can be trusted:
 *
 * **A clean month.** Every day that is not a rest day is worked in full. No
 * absences, no lates, no leave, no advance, no adjustment. A sample carrying
 * invented penalties would be answering a question nobody asked, and a person
 * comparing it against a real payslip later needs to know exactly which parts
 * of the difference are theirs.
 *
 * **The described days fill the month exactly.** `simulatePayroll` lays its
 * ledger out in order and stops at the length of the month, so describing one
 * day too many silently drops week-offs off the end and the payslip claims a
 * rest day the person did not get. Present days are therefore whatever is left
 * after the rest days, never a round 26.
 *
 * **This month, not last.** The admin preview uses the previous month because
 * it is showing a letterhead. This is showing somebody their own salary, and the
 * salary in force is today's — dating the sample to last month while paying it
 * at this month's CTC would put a figure on the page that was never true of
 * that period. Everything here is as of today: the period, the CTC, the policy.
 */
export function sampleMonthInput(
  ctcMonthlyPaise: number,
  today: DateOnly,
  /** Rest days from the employee's own weekly-off pattern, not an assumed Sunday. */
  calendar: { totalDays: number; weekOffDays: number },
): SimulationInput {
  const { year, month } = parts(today);

  // Clamped rather than trusted: a pattern marking every day a rest day would
  // otherwise produce a negative count, which the ledger would read as "no days
  // described at all" and pay in full off an empty month.
  const weekOffDays = Math.min(Math.max(0, calendar.weekOffDays), calendar.totalDays);

  return {
    ctcMonthlyPaise,
    year,
    month,
    weekOffDays,
    holidayDays: 0,
    presentDays: calendar.totalDays - weekOffDays,
  };
}
