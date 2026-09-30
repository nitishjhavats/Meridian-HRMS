import type { DateOnly } from "@/domain/date";

/**
 * Which month the grid shows, from the URL.
 *
 * The arrows on the grid only ever write a real month, so anything else in
 * `?year=&month=` was typed or pasted. `getMonthlyGrid` refuses `month=13`
 * with a ValidationError, and a six-digit year makes `daysInMonth` NaN and the
 * range query fall over -- both landed on the generic error page for a URL
 * that somebody edited by hand. Out of range means the current month, which is
 * what the page shows with no parameters at all.
 *
 * The bounds are the ones every year/month query schema under `/api` uses.
 */
export const MIN_YEAR = 2000;
export const MAX_YEAR = 2100;

export function resolveMonthParam(
  params: { year?: string; month?: string },
  today: DateOnly,
): { year: number; month: number } {
  const current = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };

  const year = params.year === undefined || params.year === "" ? current.year : Number(params.year);
  const month =
    params.month === undefined || params.month === "" ? current.month : Number(params.month);

  const yearOk = Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
  const monthOk = Number.isInteger(month) && month >= 1 && month <= 12;

  // One bad half discards both: "March of year 999999" is not a month either.
  return yearOk && monthOk ? { year, month } : current;
}
