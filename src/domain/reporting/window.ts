import { todayInZone } from "@/domain/date";

/**
 * When a reporting line is live.
 *
 * `ReportingRelationship.endDate` carries a contract the whole product depends
 * on: it is what `teamEmployeeIds` walks to resolve every `.team` scope — leave
 * approvals, visible employees, the kiosk's PIN issuing. Ending a line is a
 * date, never a delete, because a manager who approved leave last March must
 * still be the manager who approved it.
 *
 * That contract was expressed three different ways. `guard.ts` used `gte`,
 * `structure.ts` used `gt`, both compared a `@db.Date` against a full
 * timestamp, "today" was UTC in a product whose default zone is Asia/Kolkata —
 * so between midnight and 05:30 IST a line ending today was already treated as
 * ended — and **`startDate` was checked nowhere at all**, so a line dated to
 * start next month handed over the team immediately.
 *
 * One predicate, one place. The point is not `gte` over `gt`; it is that there
 * is only one of them.
 */

/** Midnight today, in the organisation's own zone, as the `@db.Date` values are stored. */
export function reportingToday(timezone = "Asia/Kolkata", now: Date = new Date()): Date {
  return new Date(`${todayInZone(timezone, now)}T00:00:00.000Z`);
}

export interface ReportingWindow {
  AND: [
    { OR: [{ startDate: null }, { startDate: { lte: Date } }] },
    { OR: [{ endDate: null }, { endDate: { gte: Date } }] },
  ];
}

/**
 * A Prisma `where` fragment matching lines that are in force today.
 *
 * A line with no dates is live. A line ending today is still live — somebody's
 * last day as a manager is a day they were the manager.
 */
export function liveReportingWhere(
  timezone = "Asia/Kolkata",
  now: Date = new Date(),
): ReportingWindow {
  const today = reportingToday(timezone, now);
  return {
    AND: [
      { OR: [{ startDate: null }, { startDate: { lte: today } }] },
      { OR: [{ endDate: null }, { endDate: { gte: today } }] },
    ],
  };
}

/** The same question about a row already in memory. */
export function isReportingLineLive(
  line: { startDate: Date | null; endDate: Date | null },
  timezone = "Asia/Kolkata",
  now: Date = new Date(),
): boolean {
  const today = reportingToday(timezone, now);
  if (line.startDate && line.startDate > today) return false;
  if (line.endDate && line.endDate < today) return false;
  return true;
}
