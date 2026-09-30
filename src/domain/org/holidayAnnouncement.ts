import type { DateOnly } from "@/domain/date";
import { formatDate } from "@/lib/utils";

/**
 * What everybody is told when a holiday goes on the calendar.
 *
 * A holiday is on the calendar so that nobody comes in, which only works if
 * they hear about it. The catalogue toggle has announced since it was built;
 * a holiday typed in by hand on the calendar screen announced nothing — so an
 * organisation adding its own local festival, which is exactly the holiday
 * nobody can look up, was the one case that stayed silent.
 *
 * Both paths now build their words here. Two copies of this sentence would
 * drift, and the drift would be invisible: nobody compares the announcement
 * they got in March with the one somebody else got in August.
 */

export interface HolidayFacts {
  name: string;
  date: DateOnly;
  /**
   * A day people may take rather than one the office is closed for.
   *
   * `buildPeriodCalendar` reads this flag and not the `type` column, so it is
   * also what decides whether the day is actually off — an announcement saying
   * "the office will be closed" about an optional holiday would contradict the
   * calendar it is announcing.
   */
  optional?: boolean;
  /** A lunar date the catalogue researched but cannot promise. */
  verify?: boolean;
}

export interface HolidayAnnouncementDraft {
  title: string;
  body: string;
}

export function holidayAnnouncement(holiday: HolidayFacts): HolidayAnnouncementDraft {
  const when = formatDate(holiday.date);
  const opening = holiday.optional
    ? `${holiday.name} falls on ${when}. It is an optional holiday: the office stays open, and you may take the day if you observe it.`
    : `${holiday.name} falls on ${when} and the office will be closed.`;

  return {
    title: `${holiday.name} — ${when}`,
    // The same caveat the catalogue has always carried, kept word for word:
    // a date somebody may still have to move is worse than useless if the
    // announcement sounds certain about it.
    body: holiday.verify
      ? `${opening} This date follows the lunar calendar, so it will be confirmed nearer the time.`
      : opening,
  };
}

export interface AnnounceDecision {
  /** Whether this write actually put a new row on the calendar. */
  created: boolean;
  date: DateOnly;
  /** Today in the organisation's own timezone. */
  today: DateOnly;
}

/**
 * Whether this particular write is news.
 *
 * Two noes, both about telling people something twice or telling them nothing.
 *
 * **Only a new row.** Correcting a spelling, moving a paid flag, or switching a
 * catalogue holiday on when somebody had already typed it in by hand are all
 * writes that change nothing anybody needs to hear about — and the last one is
 * the double announcement, because the catalogue's upsert is a no-op in exactly
 * that case and used to announce anyway.
 *
 * **Only a day that has not gone.** Holidays get back-filled: a festival is
 * added to last month's calendar so that payroll counts the day correctly.
 * "The office will be closed" about a day everybody already worked or did not
 * is a notification that can only confuse.
 */
export function shouldAnnounceHoliday(input: AnnounceDecision): boolean {
  return input.created && input.date >= input.today;
}
