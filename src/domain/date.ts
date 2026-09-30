/**
 * Calendar dates are handled as plain `YYYY-MM-DD` strings, never as `Date`.
 *
 * Attendance, payroll periods, holidays and week-offs are *calendar* facts in the
 * organisation's timezone; using JS `Date` for them silently shifts days across
 * UTC boundaries. Instants (a check-in timestamp) stay as `Date` — those are
 * genuinely points in time.
 */

export type DateOnly = string; // "YYYY-MM-DD"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class DateError extends Error {}

export function isDateOnly(value: unknown): value is DateOnly {
  return typeof value === "string" && DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function assertDateOnly(value: string): DateOnly {
  if (!isDateOnly(value)) throw new DateError(`invalid date: ${value}`);
  return value;
}

export function makeDate(year: number, month: number, day: number): DateOnly {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return assertDateOnly(`${year}-${m}-${d}`);
}

export function parts(date: DateOnly): { year: number; month: number; day: number } {
  assertDateOnly(date);
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

/** UTC-anchored Date used only for arithmetic; never rendered to a user. */
function toUtc(date: DateOnly): Date {
  return new Date(`${assertDateOnly(date)}T00:00:00.000Z`);
}

function fromUtc(d: Date): DateOnly {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: DateOnly, days: number): DateOnly {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

export function addMonths(date: DateOnly, months: number): DateOnly {
  const { year, month, day } = parts(date);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const maxDay = daysInMonth(y, m);
  return makeDate(y, m, Math.min(day, maxDay));
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: DateOnly): number {
  return toUtc(date).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function startOfMonth(year: number, month: number): DateOnly {
  return makeDate(year, month, 1);
}

export function endOfMonth(year: number, month: number): DateOnly {
  return makeDate(year, month, daysInMonth(year, month));
}

/** Inclusive difference in days (b − a). */
export function diffDays(a: DateOnly, b: DateOnly): number {
  return Math.round((toUtc(b).getTime() - toUtc(a).getTime()) / 86_400_000);
}

export function compare(a: DateOnly, b: DateOnly): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function min(a: DateOnly, b: DateOnly): DateOnly {
  return a <= b ? a : b;
}

export function max(a: DateOnly, b: DateOnly): DateOnly {
  return a >= b ? a : b;
}

export function isBetween(date: DateOnly, start: DateOnly, end: DateOnly): boolean {
  return date >= start && date <= end;
}

/** Inclusive list of dates from `start` to `end`. */
export function eachDay(start: DateOnly, end: DateOnly): DateOnly[] {
  if (compare(start, end) > 0) return [];
  const out: DateOnly[] = [];
  let cursor = start;
  // Guard against a runaway loop from bad input (max ~10 years).
  for (let i = 0; i <= 3700 && compare(cursor, end) <= 0; i++) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/**
 * Which occurrence of this weekday within the month the date is
 * (1 = 1st Saturday, 2 = 2nd Saturday, …). Used by rotational week-offs.
 */
export function weekdayOccurrenceInMonth(date: DateOnly): number {
  return Math.floor((parts(date).day - 1) / 7) + 1;
}

/** ISO week number — used for alternating (odd/even week) rotations. */
export function isoWeekNumber(date: DateOnly): number {
  const d = toUtc(date);
  const day = (d.getUTCDay() + 6) % 7; // Mon = 0
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

/** "HH:MM" → minutes past midnight. */
export function timeToMinutes(time: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) throw new DateError(`invalid time: ${time}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new DateError(`invalid time: ${time}`);
  return hours * 60 + minutes;
}

export function minutesToTime(total: number): string {
  const wrapped = ((total % 1440) + 1440) % 1440;
  const h = String(Math.floor(wrapped / 60)).padStart(2, "0");
  const m = String(wrapped % 60).padStart(2, "0");
  return `${h}:${m}`;
}

/** Convert an instant to the calendar date + minutes-past-midnight in an IANA zone. */
/**
 * Whether Intl knows this zone. Cached: it is asked on every date the product
 * touches.
 */
const knownZones = new Map<string, boolean>();
export function isValidTimeZone(timeZone: string): boolean {
  const cached = knownZones.get(timeZone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    ok = true;
  } catch {
    ok = false;
  }
  knownZones.set(timeZone, ok);
  return ok;
}

/** The zone every organisation on this instance actually lives in. */
export const FALLBACK_TIME_ZONE = "Asia/Kolkata";

export function instantInZone(
  instant: Date,
  timeZone: string,
): { date: DateOnly; minutes: number } {
  /**
   * A bad zone is not allowed to take a company down.
   *
   * The timezone was a free-text box on the platform's organisation form with
   * no check anywhere, and `Intl` throws `RangeError` on a typo -- from the
   * dashboard, from every attendance and payroll screen, for every employee of
   * that organisation, with nothing they could do about it. The box now
   * validates; this is the belt under the braces.
   */
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const hour = map.hour === "24" ? "00" : (map.hour ?? "00");
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    minutes: Number(hour) * 60 + Number(map.minute ?? "0"),
  };
}

export function todayInZone(timeZone: string, now: Date = new Date()): DateOnly {
  return instantInZone(now, timeZone).date;
}

/** The zone's UTC offset, in minutes, at a given instant. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const local = instantInZone(instant, timeZone);
  const asIfUtc = new Date(`${local.date}T00:00:00.000Z`).getTime() + local.minutes * 60_000;
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/**
 * The inverse of `instantInZone`: a wall-clock time in a zone → a real instant.
 *
 * A shift that starts at 09:00 in Asia/Kolkata is 03:30 UTC, not 09:00 UTC.
 * Getting this backwards is how seeded or imported attendance ends up showing
 * check-ins in the afternoon.
 *
 * The offset is resolved twice, because the first guess can land on the wrong
 * side of a daylight-saving change in zones that observe one.
 */
export function zonedTimeToInstant(date: DateOnly, minutes: number, timeZone: string): Date {
  const naive = new Date(`${assertDateOnly(date)}T00:00:00.000Z`).getTime() + minutes * 60_000;
  const firstGuess = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
  const offset = zoneOffsetMinutes(new Date(firstGuess), timeZone);
  return new Date(naive - offset * 60_000);
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? month} ${year}`;
}
