import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The sample payslip's permission boundary, read off the source.
 *
 * There is no pure function to test here and Prisma is never mocked, so this
 * reads the files. That is the right shape for this particular rule, because the
 * rule is about what the code does *not* contain: the employee is
 * `ctx.employeeId` and there is no parameter anywhere on the path from the URL
 * to the query. A test that called the service could only ever prove that
 * today's implementation is safe; this proves the shape that keeps it safe, and
 * fails the moment somebody adds `?employeeId=` to make the endpoint reusable
 * for an admin screen.
 *
 * The arithmetic itself is pinned in `domain/payroll/sample.test.ts`. What this
 * adds is the caller: a pure function nobody calls is not a feature.
 */

const ROUTE_DIR = path.resolve("src/app/api/payroll/slips/sample");
const ROUTE = readFileSync(path.join(ROUTE_DIR, "route.ts"), "utf8");
const SERVICE = readFileSync(path.resolve("src/services/payroll/samplePayslip.ts"), "utf8");

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the sample payslip route takes no employee id", () => {
  const code = strip(ROUTE);

  it("has no dynamic segment in its path", () => {
    // `src/app/api/payroll/slips/sample/[employeeId]/route.ts` would be the
    // whole breach with none of the words below changed.
    expect(readdirSync(ROUTE_DIR)).toEqual(["route.ts"]);
  });

  it("never mentions an employee id at all", () => {
    // Deliberately the whole file, comments stripped: not `employeeId`, not
    // `employee_id`, not `empId`. The service resolves the employee from the
    // session; there is nothing here for a caller to influence.
    expect(code).not.toMatch(/employee[_-]?id/i);
  });

  it("reads nothing off the request", () => {
    // No query string, no body. A sample payslip has no options.
    expect(code).not.toMatch(/searchParams|new URL\(|parseQuery|parseBody|request\.json/);
    expect(code).not.toMatch(/\bparams\b/);
  });

  it("passes only the auth context to the service", () => {
    expect(code).toMatch(/renderMySamplePayslip\(ctx\)/);
  });

  it("streams it inline and refuses to let it be cached", () => {
    expect(code).toMatch(/"Content-Type": "application\/pdf"/);
    expect(code).toMatch(/inline; filename=/);
    expect(code).toMatch(/"Cache-Control": "no-store"/);
  });
});

describe("the sample is built from the signed-in employee's own record", () => {
  const code = strip(SERVICE);

  it("takes the context and nothing else", () => {
    expect(code).toMatch(/export async function renderMySamplePayslip\(ctx: AuthContext\)/);
  });

  it("derives the employee from the session", () => {
    expect(code).toMatch(/const employeeId = ctx\.employeeId/);
    expect(code).toMatch(/if \(!employeeId\)/);
  });

  it("guards on the org, the self-read permission and the payroll module", () => {
    expect(code).toMatch(/requireOrg\(ctx\)/);
    expect(code).toMatch(/requirePermission\(ctx, "payroll\.read\.self"\)/);
    expect(code).toMatch(/requireModule\(ctx, "payroll"\)/);
    // Reading somebody else's pay is a different permission and has no business
    // being accepted here, in either direction.
    expect(code).not.toMatch(/payroll\.read\.all/);
  });

  it("scopes both reads by organisation as well as employee", () => {
    // Neither query may be reachable with an employee id alone: a bare `where`
    // on a money table is the shape a later refactor makes cross-tenant.
    const employeeQuery = code.slice(code.indexOf("prisma.employee.findFirst"));
    expect(employeeQuery.slice(0, 200)).toMatch(/id: employeeId,\s*organizationId: ctx\.organizationId/);

    const salaryQuery = code.slice(code.indexOf("prisma.salaryProfile.findFirst"));
    expect(salaryQuery.slice(0, 260)).toMatch(/organizationId: ctx\.organizationId,\s*employeeId,/);
  });

  it("still builds a sample with no salary on record, and says the figure is an example", () => {
    /**
     * This used to assert the opposite: that the service threw, and the screen
     * hid the button when it would have. Both were defensible in the abstract
     * and wrong in fact -- **not one employee in the production database has a
     * `SalaryProfile`**, so the control was hidden from every person the
     * feature was written for, and "my salary me sample payslip nahi aata" was
     * exactly right.
     *
     * A page of zeros would still be wrong, because it reads as a statement
     * that somebody is owed nothing. An example figure the page names as an
     * example is neither.
     */
    expect(code).not.toMatch(/throw new ConflictError\(/);
    expect(code).toMatch(/const ctcIsExample = profile === null;/);
    expect(code).toMatch(/ctcIsExample\s*\?/);
    // And the note says which it is, rather than leaving the reader to guess.
    expect(code).toMatch(/an example figure/);
  });

  it("computes the figures through the real engine, not from invented ones", () => {
    // The whole point of the feature. A second set of arithmetic here would
    // drift from payroll and the sample would stop predicting anything.
    expect(code).toMatch(/sampleMonthInput\(ctcMonthlyPaise, today, \{/);
    expect(code).toMatch(/simulatePayroll\(/);
    expect(code).toMatch(/getPayrollPolicy\(ctx, today\)/);
    // The one example figure is named once and used once; nothing else stands
    // in for a salary.
    expect(code).toMatch(/profile\?\.ctcMonthlyPaise \?\? EXAMPLE_CTC_PAISE/);
    expect((code.match(/EXAMPLE_CTC_PAISE/g) ?? []).length).toBe(2);
  });

  it("marks the page so it cannot be mistaken for a real payslip", () => {
    expect(code).toMatch(/watermark: SAMPLE_WATERMARK/);
    expect(SERVICE).toMatch(/SAMPLE_WATERMARK = "DEMO"/);
    expect(code).toMatch(/slipNumber = `SAMPLE\//);
  });

  it("stores nothing and audits nothing", () => {
    // It is not a record of anything: it changes the moment a salary or a
    // policy does, and caching it would hand somebody a stale figure.
    expect(code).not.toMatch(/storage\(\)/);
    expect(code).not.toMatch(/writeAudit/);
    expect(code).not.toMatch(/salarySlip\.(upsert|create|update)/);
  });
});
