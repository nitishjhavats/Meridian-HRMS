/**
 * The holidays an Indian organisation is most likely to want, ready to switch on.
 *
 * **Why a catalogue in code.** No organisation gets any holidays when it is
 * created — provisioning seeds a shift, a weekly-off pattern, leave types and
 * salary components, and no holidays at all — so every new company started by
 * typing Republic Day into a form. And a holiday matters more than most
 * settings: it decides whether a day is payable.
 *
 * Switching one on creates a `Holiday` row; switching it off deletes it. That
 * looks lossy and is not, because this list is the memory: a holiday removed
 * this year is still here to add next year. It is also why there is no
 * `enabled` column — one would have to be honoured by all five readers of the
 * holiday table, and forgetting one of them means a day that is a holiday for
 * attendance and a working day for payroll.
 *
 * **The three national days are computed, not listed.** They fall on the same
 * date every year, so listing them would mean this file running out in 2030 for
 * the one thing it can be certain about.
 *
 * **The festivals are listed, and every one is marked to check.** They follow
 * the lunar calendar, the dates below came from published tables rather than
 * from an ephemeris in this codebase, and a regional calendar can differ by a
 * day. So the product asks somebody to confirm rather than quietly deciding
 * that a day nobody is coming to work is a day everybody is absent.
 */

export interface CatalogueHoliday {
  /** Stable across years, so a row can be matched back to its entry. */
  key: string;
  name: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /**
   * True for anything on the lunar calendar. The screen says so and asks for
   * confirmation; the three fixed national days do not need it.
   */
  verify: boolean;
  /**
   * A gazetted national holiday: on by default, and added again every year.
   *
   * Switchable, unlike the round-7 version of this. Off is a real answer -- a
   * plant running a shift on Republic Day exists -- and once it is off the
   * yearly job leaves it off, because that job never revisits a year it has
   * already seeded.
   */
  defaultOn: boolean;
}

/** The years the festival dates below cover. */
export const CATALOGUE_YEARS = [2026, 2027, 2028, 2029, 2030] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Same date every year, for as long as there is a country.
 *
 * These three are gazetted national holidays, so they arrive **on** and arrive
 * **every year** without anybody adding them. An organisation can still switch
 * one off: a factory running a shift on Republic Day is a real thing, and a
 * product that refuses to describe it is wrong about the world rather than
 * careful.
 *
 * Round 7 made them un-switchable and that was one step too far -- corrected
 * here. What survives from it is the part that mattered: a calendar that starts
 * empty is a calendar that calls 26 January a working day, and nobody notices
 * until somebody is marked absent on it.
 *
 * "Every year" is `holidaysSeededThrough` on the organisation: the maintenance
 * job seeds a year once and records that it did. A holiday switched off stays
 * off, because the job never revisits a year it has already seeded.
 */
const FIXED: { key: string; name: string; month: number; day: number }[] = [
  { key: "republic-day", name: "Republic Day", month: 1, day: 26 },
  { key: "independence-day", name: "Independence Day", month: 8, day: 15 },
  { key: "gandhi-jayanti", name: "Gandhi Jayanti", month: 10, day: 2 },
];

/** The keys that arrive switched on. */
export const DEFAULT_ON_KEYS: readonly string[] = FIXED.map((h) => h.key);

/**
 * Whether a catalogue entry is one of the three that arrives on.
 *
 * By key rather than by name, because a name is what somebody typed and a key
 * is what the catalogue means. An organisation with its own holiday called
 * "Republic Day" on a different date is their own affair.
 */
export function isDefaultOnHoliday(key: string): boolean {
  return DEFAULT_ON_KEYS.includes(key);
}

/**
 * The three, for a given year, as rows ready to be created.
 *
 * Used by provisioning, by the yearly job and by the backfill, so a new
 * organisation, an old one and next January all end up with the same calendar
 * rather than three lists that drift.
 */
export function defaultOnHolidays(year: number): CatalogueHoliday[] {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return [];
  return FIXED.map((h) => ({
    key: h.key,
    name: h.name,
    date: `${year}-${pad(h.month)}-${pad(h.day)}`,
    verify: false,
    defaultOn: true,
  }));
}

/**
 * Lunar festivals, by year.
 *
 * Sources were published date tables, cross-checked between two of them where
 * they disagreed. They stop at 2030 rather than being extrapolated: a wrong
 * date here is a day somebody is marked absent for not coming to work.
 */
const FESTIVALS: Record<number, { key: string; name: string; date: string }[]> = {
  2026: [
    { key: "holi", name: "Holi", date: "2026-03-04" },
    { key: "dussehra", name: "Dussehra", date: "2026-10-20" },
    { key: "diwali", name: "Diwali", date: "2026-11-08" },
  ],
  2027: [
    { key: "holi", name: "Holi", date: "2027-03-22" },
    { key: "dussehra", name: "Dussehra", date: "2027-10-09" },
    { key: "diwali", name: "Diwali", date: "2027-10-29" },
  ],
  2028: [
    { key: "holi", name: "Holi", date: "2028-03-11" },
    { key: "dussehra", name: "Dussehra", date: "2028-09-27" },
    { key: "diwali", name: "Diwali", date: "2028-11-12" },
  ],
  2029: [
    { key: "holi", name: "Holi", date: "2029-02-28" },
    { key: "dussehra", name: "Dussehra", date: "2029-10-16" },
    { key: "diwali", name: "Diwali", date: "2029-11-01" },
  ],
  2030: [
    { key: "holi", name: "Holi", date: "2030-03-20" },
    { key: "dussehra", name: "Dussehra", date: "2030-10-06" },
    { key: "diwali", name: "Diwali", date: "2030-10-22" },
  ],
};

/**
 * Everything on offer for one year, in date order.
 *
 * The national days are always there. The festivals are there for the years
 * they were researched for, and simply absent afterwards — an empty list is
 * honest, and a guessed date is not.
 */
export function holidayCatalogue(year: number): CatalogueHoliday[] {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return [];

  const fixed: CatalogueHoliday[] = defaultOnHolidays(year);

  const festivals: CatalogueHoliday[] = (FESTIVALS[year] ?? []).map((h) => ({
    key: h.key,
    name: h.name,
    date: h.date,
    verify: true,
    defaultOn: false,
  }));

  return [...fixed, ...festivals].sort((a, b) => a.date.localeCompare(b.date));
}

/** Whether this year's festival dates are known, for the screen to say so. */
export function hasFestivalDates(year: number): boolean {
  return (FESTIVALS[year]?.length ?? 0) > 0;
}
