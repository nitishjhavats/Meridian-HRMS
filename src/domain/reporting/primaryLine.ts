/**
 * The one PRIMARY reporting line that has not been ended.
 *
 * A manager is replaced or removed by setting `endDate` on the old row, never
 * by deleting it -- the approval they gave last March must keep its manager --
 * so "who is their manager now" is the PRIMARY row with no end date. The
 * partial index `ReportingRelationship_one_live_primary` keeps that unique per
 * employee, and it is the row a manager change on the employee form ends.
 *
 * Distinct from `liveReportingWhere`, which asks whether a line is in force
 * *today* and is what every `.team` scope walks: there, a line ending today
 * still counts, because somebody's last day as a manager is a day they were
 * the manager. Here it does not. "Nobody" chosen this morning means nobody --
 * the edit dialog opens on an empty field, and a review cycle opened this
 * afternoon does not hand the review to the manager they no longer have.
 *
 * This used to be written out by hand in the profile page, in
 * `updateEmployee`, in `attachReportingLine`, and -- without the end date at
 * all -- in `openCycle` and the count beside it. Copies agree until one is
 * edited.
 */
export const LIVE_PRIMARY_LINE = { type: "PRIMARY", endDate: null } as const;
