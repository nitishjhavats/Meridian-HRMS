/**
 * Which payroll run a report reads for a month.
 *
 * A month is not one `PayrollRun`. Locking is final, so correcting a locked
 * month never edits the run that was paid: `reopenRun` leaves it exactly as it
 * was and opens a fresh revision beside it. A month corrected once therefore
 * holds a LOCKED revision 1 and a DRAFT revision 2; a month corrected and
 * locked again holds two LOCKED runs; and both live under the same period.
 *
 * Every payroll report used to select its rows by period alone —
 * `run: { periodYear, periodMonth }` — which is *every* revision at once. So a
 * revised month listed each employee once per revision and every money column
 * added up twice or more: a register that should have read ₹42L read ₹84L, a
 * salary breakdown showed two rows per person with no way to tell which was
 * paid, and there was no way at all to ask for the figures that were actually
 * locked. Payroll totals handed to an auditor or a bank were simply wrong.
 *
 * This is the single rule for choosing one of them. Pure — rows in, rows out —
 * so the choice is testable without a database, and so the reports, and
 * anything else that grows the same need, cannot each answer it differently.
 */

/** Mirrors `PayrollRunStatus` in the schema. Redeclared: domain imports no client. */
export type ReportedRunStatus = "DRAFT" | "CALCULATED" | "APPROVED" | "LOCKED" | "CANCELLED";

export interface ReportableRun {
  id: string;
  periodYear: number;
  /** 1-12. */
  periodMonth: number;
  /** 1 for a month's first run; reopening adds 2, 3, … */
  revision: number;
  status: ReportedRunStatus;
}

/**
 * How much a status entitles a run to be the month's answer.
 *
 * Status outranks revision, and that ordering is the whole point: a month whose
 * revision 1 is LOCKED and whose revision 2 is a draft somebody opened this
 * morning still reports the locked figures. A draft is an intention, not
 * payroll — reporting it would restate a paid month from numbers nobody has
 * approved. Once that draft is approved it wins on its own merit.
 */
const AUTHORITY: Record<Exclude<ReportedRunStatus, "CANCELLED">, number> = {
  LOCKED: 4,
  APPROVED: 3,
  // Below approval only as a last resort: without these a month still being
  // prepared would report nothing at all, and previewing the register before
  // approving it is exactly when somebody looks.
  CALCULATED: 2,
  DRAFT: 1,
};

/** Both halves of a period as one string, so runs can be grouped by month. */
export function payrollMonthKey(run: Pick<ReportableRun, "periodYear" | "periodMonth">): string {
  return `${run.periodYear}-${String(run.periodMonth).padStart(2, "0")}`;
}

function authorityOf(run: ReportableRun): number {
  return run.status === "CANCELLED" ? 0 : AUTHORITY[run.status];
}

function beats(candidate: ReportableRun, incumbent: ReportableRun): boolean {
  const a = authorityOf(candidate);
  const b = authorityOf(incumbent);
  if (a !== b) return a > b;
  // Same standing: the later attempt is the current one. Two locked runs means
  // the month was reopened and locked again, and the second lock is what stands.
  if (candidate.revision !== incumbent.revision) return candidate.revision > incumbent.revision;
  // Unreachable through the database — (organizationId, year, month, revision)
  // is unique — but the answer must never depend on the order rows arrived in.
  return candidate.id > incumbent.id;
}

/**
 * The one run to report on, out of the runs for a **single** month.
 *
 * The locked one; failing that the newest approved one; failing that the
 * newest run that exists. `null` when there is nothing to report — no runs, or
 * only cancelled ones.
 *
 * A cancelled run is never the answer, not even the only one: it is a month
 * somebody abandoned, and its items are figures that were explicitly disowned.
 */
export function runToReportOn<T extends ReportableRun>(runs: readonly T[]): T | null {
  let best: T | null = null;
  for (const run of runs) {
    if (run.status === "CANCELLED") continue;
    if (best === null || beats(run, best)) best = run;
  }
  return best;
}

/**
 * One run per month, out of runs spanning any number of months.
 *
 * Never more than one per month — that is the property the reports depend on.
 * Ordered oldest month first, so a caller that renders them does not have to
 * re-sort a Map's insertion order.
 */
export function runsToReportOn<T extends ReportableRun>(runs: readonly T[]): T[] {
  const byMonth = new Map<string, T[]>();
  for (const run of runs) {
    const key = payrollMonthKey(run);
    const bucket = byMonth.get(key);
    if (bucket) bucket.push(run);
    else byMonth.set(key, [run]);
  }

  const chosen: T[] = [];
  for (const bucket of byMonth.values()) {
    const pick = runToReportOn(bucket);
    if (pick) chosen.push(pick);
  }

  return chosen.sort((a, b) => a.periodYear - b.periodYear || a.periodMonth - b.periodMonth);
}

/**
 * The same answer as ids, which is the shape a `where` clause wants.
 *
 * An empty array is a real answer — `payrollRunId: { in: [] }` matches nothing,
 * which is the correct report for a month that has no run worth reporting.
 */
export function reportedRunIds(runs: readonly ReportableRun[]): string[] {
  return runsToReportOn(runs).map((run) => run.id);
}
