import type { DateOnly } from "../date";

/**
 * Onboarding templates, decided without a database.
 *
 * A template is a named list of steps, each carrying an offset in days from the
 * joiner's first day. Applying it copies those steps into dated tasks for one
 * person. Everything here is the part of that which does not need Prisma: how a
 * day-offset reads in English, which employees can be scheduled at all, and
 * where a step lands when somebody moves it.
 */

/** "3 days before joining", "on the joining day", "7 days after joining". */
export function offsetLabel(days: number): string {
  if (days === 0) return "on the joining day";
  if (days === 1) return "1 day after joining";
  if (days === -1) return "1 day before joining";
  return days > 0 ? `${days} days after joining` : `${-days} days before joining`;
}

export interface Joiner {
  joiningDate: DateOnly | null;
}

/**
 * Who can be set up, and who cannot.
 *
 * Every date on an onboarding task is joining date + offset, so an employee
 * without a joining date has nothing to count from. The screen used to offer
 * all of them and let the server refuse — and because the employee list is
 * sorted by joining date descending, Postgres put the undated rows *first*, so
 * the person pre-selected in the dropdown was usually one of the ones that
 * could not work.
 */
export function splitByJoiningDate<T extends Joiner>(employees: T[]): { ready: T[]; undated: T[] } {
  const ready: T[] = [];
  const undated: T[] = [];
  for (const employee of employees) {
    if (employee.joiningDate) ready.push(employee);
    else undated.push(employee);
  }
  return { ready, undated };
}

/**
 * The id order after moving one step up (-1) or down (1).
 *
 * Returns the list unchanged when the step is already at the end it is being
 * moved towards, so the caller can rewrite `sortOrder` unconditionally without
 * a special case for "nothing happened".
 */
export function moveStep(ids: string[], id: string, direction: -1 | 1): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;

  const to = from + direction;
  if (to < 0 || to >= ids.length) return ids;

  const next = [...ids];
  const moved = next[from];
  const displaced = next[to];
  if (moved === undefined || displaced === undefined) return ids;

  next[from] = displaced;
  next[to] = moved;
  return next;
}

/**
 * Keeps a selection pointing at something that exists.
 *
 * A dropdown whose value is a stale id renders as its first option while
 * holding a value nothing matches, which is how the Template picker ended up
 * showing a template and refusing to apply it: the state was seeded from an
 * empty list on first render, and `router.refresh()` re-renders the server
 * component without resetting client state. So the value is derived on every
 * render instead of stored.
 */
export function resolveChoice<T extends { id: string }>(options: T[], chosen: string): T | null {
  return options.find((option) => option.id === chosen) ?? options[0] ?? null;
}

export type StepTiming = "before" | "on" | "after";

/**
 * A day-offset from the two controls that ask for it.
 *
 * Asked as a timing and a count rather than a signed integer, because "-3" is
 * not a thing anybody has in mind when they mean "three days before they
 * start" — and because the shared number input refuses a minus sign, being
 * built for quantities.
 */
export function toOffsetDays(timing: StepTiming, days: number | null): number {
  if (timing === "on") return 0;
  const count = Math.abs(Math.round(days ?? 0));
  // Guarded because `-0` is what negating zero gives, and it is a different
  // value to every equality check that is not `==`.
  if (count === 0) return 0;
  return timing === "before" ? -count : count;
}
