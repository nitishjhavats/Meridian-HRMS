import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  payrollMonthKey,
  reportedRunIds,
  runToReportOn,
  runsToReportOn,
  type ReportableRun,
  type ReportedRunStatus,
} from "./reportedRuns";

/**
 * The rule these tests are about: a revised month has more than one run under
 * the same period, and a report that matches on the period alone counts the
 * month twice. The interesting cases are all shapes `reopenRun` can actually
 * produce -- a locked run with a draft beside it, two locked runs, a month
 * still being prepared -- because those are the shapes that reach a report.
 */

const run = (
  revision: number,
  status: ReportedRunStatus,
  overrides: Partial<ReportableRun> = {},
): ReportableRun => ({
  id: `run-${overrides.periodYear ?? 2026}-${overrides.periodMonth ?? 3}-r${revision}`,
  periodYear: 2026,
  periodMonth: 3,
  revision,
  status,
  ...overrides,
});

describe("runToReportOn", () => {
  it("returns nothing when the month has no run", () => {
    expect(runToReportOn([])).toBeNull();
  });

  it("reports a month that is still being prepared", () => {
    // Not payroll yet, but it is the only answer there is, and previewing the
    // register before approving it is exactly when somebody runs the report.
    expect(runToReportOn([run(1, "DRAFT")])?.revision).toBe(1);
    expect(runToReportOn([run(1, "CALCULATED")])?.revision).toBe(1);
  });

  it("prefers the locked run over a newer draft", () => {
    // The case this whole file exists for. Somebody reopened March to fix one
    // person's attendance; revision 2 is a draft opened this morning. March was
    // paid from revision 1 and that is what March's register has to say.
    const chosen = runToReportOn([run(1, "LOCKED"), run(2, "DRAFT")]);
    expect(chosen?.revision).toBe(1);
    expect(chosen?.status).toBe("LOCKED");
  });

  it("prefers the locked run over a newer approved one", () => {
    const chosen = runToReportOn([run(1, "LOCKED"), run(2, "APPROVED")]);
    expect(chosen?.revision).toBe(1);
  });

  it("prefers a calculated run over a newer draft", () => {
    const chosen = runToReportOn([run(1, "CALCULATED"), run(2, "DRAFT")]);
    expect(chosen?.revision).toBe(1);
  });

  it("takes the newest approved run when none is locked", () => {
    const chosen = runToReportOn([run(1, "APPROVED"), run(2, "APPROVED")]);
    expect(chosen?.revision).toBe(2);
  });

  it("takes the second lock when a month was reopened and locked again", () => {
    // Both runs are LOCKED and both are real: revision 1 is what was paid in
    // April, revision 2 is the correction that superseded it. The correction is
    // the month's standing answer -- and either way it is one of them, not both.
    const chosen = runToReportOn([run(1, "LOCKED"), run(2, "LOCKED")]);
    expect(chosen?.revision).toBe(2);
  });

  it("never answers with a cancelled run", () => {
    expect(runToReportOn([run(1, "CANCELLED")])).toBeNull();
    expect(runToReportOn([run(1, "CANCELLED"), run(2, "DRAFT")])?.revision).toBe(2);
    // An abandoned run beside a paid one must not outrank it either.
    expect(runToReportOn([run(1, "LOCKED"), run(2, "CANCELLED")])?.revision).toBe(1);
  });

  it("does not depend on the order the rows arrive in", () => {
    const runs = [run(3, "DRAFT"), run(1, "LOCKED"), run(2, "CANCELLED")];
    const forwards = runToReportOn(runs)?.id;
    const backwards = runToReportOn([...runs].reverse())?.id;
    expect(forwards).toBe(backwards);
    expect(forwards).toBe(runs[1]!.id);
  });
});

describe("runsToReportOn", () => {
  it("returns exactly one run per month", () => {
    const runs = [
      run(1, "LOCKED", { periodMonth: 1 }),
      run(1, "LOCKED", { periodMonth: 2 }),
      run(2, "DRAFT", { periodMonth: 2 }),
      run(3, "APPROVED", { periodMonth: 2 }),
      run(1, "CALCULATED", { periodMonth: 3 }),
    ];
    const chosen = runsToReportOn(runs);
    expect(chosen).toHaveLength(3);
    expect(chosen.map((r) => `${r.periodMonth}/${r.revision}`)).toEqual(["1/1", "2/1", "3/1"]);
    // The property every payroll report now leans on.
    expect(new Set(chosen.map(payrollMonthKey)).size).toBe(chosen.length);
  });

  it("keeps months apart across a year boundary", () => {
    const chosen = runsToReportOn([
      run(1, "LOCKED", { periodYear: 2025, periodMonth: 12 }),
      run(1, "LOCKED", { periodYear: 2026, periodMonth: 12 }),
    ]);
    expect(chosen).toHaveLength(2);
    expect(chosen.map((r) => r.periodYear)).toEqual([2025, 2026]);
  });

  it("orders oldest month first", () => {
    const chosen = runsToReportOn([
      run(1, "LOCKED", { periodYear: 2026, periodMonth: 4 }),
      run(1, "LOCKED", { periodYear: 2025, periodMonth: 11 }),
      run(1, "LOCKED", { periodYear: 2026, periodMonth: 1 }),
    ]);
    expect(chosen.map(payrollMonthKey)).toEqual(["2025-11", "2026-01", "2026-04"]);
  });

  it("drops a month whose only runs were cancelled", () => {
    const chosen = runsToReportOn([
      run(1, "CANCELLED", { periodMonth: 5 }),
      run(2, "CANCELLED", { periodMonth: 5 }),
      run(1, "LOCKED", { periodMonth: 6 }),
    ]);
    expect(chosen.map((r) => r.periodMonth)).toEqual([6]);
  });

  it("returns nothing for nothing", () => {
    expect(runsToReportOn([])).toEqual([]);
  });
});

describe("reportedRunIds", () => {
  it("gives the ids a where clause wants, one per month", () => {
    const locked = run(1, "LOCKED");
    const draft = run(2, "DRAFT");
    expect(reportedRunIds([locked, draft])).toEqual([locked.id]);
  });

  it("gives an empty list when there is nothing to report", () => {
    // `payrollRunId: { in: [] }` matches nothing, which is the correct report
    // for a month with no run -- not "every row in the table".
    expect(reportedRunIds([])).toEqual([]);
  });
});

describe("payrollMonthKey", () => {
  it("pads the month so keys sort and compare as text", () => {
    expect(payrollMonthKey({ periodYear: 2026, periodMonth: 3 })).toBe("2026-03");
    expect(payrollMonthKey({ periodYear: 2026, periodMonth: 11 })).toBe("2026-11");
  });
});

/**
 * Source guards.
 *
 * The pure rule is worth nothing if a report goes back to matching on the
 * period. These read the report builder and prove each payroll report resolves
 * a run first and filters on its id -- comments stripped, so a comment about
 * the period cannot pass for the code that used to select on it.
 */

const REPORTS_PATH = path.resolve("src/services/reports/index.ts");
const REPORTS_CODE = readFileSync(REPORTS_PATH, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

/** The body of one `case` in the report builder's switch. */
function reportCase(kind: string): string {
  const start = REPORTS_CODE.indexOf(`case "${kind}": {`);
  expect(start, `${kind} is no longer a case in the report builder`).toBeGreaterThan(-1);
  const rest = REPORTS_CODE.slice(start + 1);
  const next = rest.indexOf('\n    case "');
  return next === -1 ? rest : rest.slice(0, next);
}

const PAYROLL_REPORTS = ["payroll-register", "salary-breakdown", "salary-disbursement"] as const;

describe("the report builder uses the rule", () => {
  it("imports it from the domain", () => {
    expect(REPORTS_CODE).toMatch(
      /import \{ reportedRunIds \} from "@\/domain\/payroll\/reportedRuns"/,
    );
  });

  it("resolves the month's runs through it, in one place", () => {
    const helper = REPORTS_CODE.slice(REPORTS_CODE.indexOf("async function runIdsForMonth"));
    expect(helper).toContain("return reportedRunIds(runs);");
    // Scoped by tenant: another organisation's March is not this one's March.
    expect(helper).toContain("organizationId: orgId");
  });

  for (const kind of PAYROLL_REPORTS) {
    describe(kind, () => {
      it("asks which run the month should report on", () => {
        expect(reportCase(kind)).toContain("await runIdsForMonth(orgId, year, month)");
      });

      it("filters items by that run", () => {
        expect(reportCase(kind)).toContain("payrollRunId: { in: runIds }");
      });

      it("does not select on the period any more", () => {
        // `run: { periodYear: year, periodMonth: month }` is every revision of a
        // revised month at once, which is what double-counted it.
        expect(reportCase(kind)).not.toContain("periodYear");
        expect(reportCase(kind)).not.toContain("periodMonth");
      });
    });
  }
});
