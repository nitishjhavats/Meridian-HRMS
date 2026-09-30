import type { DateOnly } from "../date";

/**
 * Laying a month's days into a week grid.
 *
 * The per-employee calendar used to render its days straight into a seven-wide
 * grid with no leading offset, so the first of the month always sat in the
 * first column and every column was a different weekday depending on the
 * month. "Which Sundays were week offs" — the question an attendance calendar
 * is opened to answer — could not be read off it. There was no weekday header
 * row either, because there could not have been a correct one.
 */

/** Monday first. The week-off patterns this product ships are written that way. */
export const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"] as const;

/**
 * How many empty cells go before the first day shown.
 *
 * `Date.getUTCDay()` is Sunday-first, hence the rotation. Returns 0 for a
 * missing or unparseable date rather than NaN, because NaN cells would render
 * as nothing at all and silently un-align the grid this exists to align.
 */
export function leadingBlanks(firstDate: DateOnly | string | undefined | null): number {
  if (!firstDate) return 0;
  const day = new Date(`${firstDate}T00:00:00.000Z`).getUTCDay();
  if (!Number.isFinite(day)) return 0;
  return (day + 6) % 7;
}
