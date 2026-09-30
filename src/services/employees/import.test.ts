import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/domain/csv";
import {
  planEmployeeImport,
  type ImportLookups,
  type ImportPlan,
  type ImportRow,
} from "@/domain/employees/import";
import { commitEmployeeImport, decideImportCommit } from "./import";

/**
 * The service half of the employee import.
 *
 * `planEmployeeImport` — what each row means — is tested in
 * src/domain/employees/import.test.ts. What is tested here is the part that
 * decides whether a file gets written at all, and the two structural promises
 * around it: the plan is rebuilt from the uploaded file rather than accepted
 * from the browser, and the inserts are one transaction.
 *
 * Both of those break silently. A commit that trusted the preview's plan would
 * import perfectly ordinary-looking employees, and a commit that lost its
 * transaction would only misbehave on the day a row happens to collide —
 * halfway through a payroll roster, with no way to tell by looking which half
 * landed.
 */

const SOURCE = readFileSync(path.resolve("src/services/employees/import.ts"), "utf8");

/** Comments stripped, so a comment about a rule cannot stand in for the rule. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

function body(name: string): string {
  const start = CODE.indexOf(`export async function ${name}(`);
  if (start === -1) throw new Error(`import.ts no longer exports ${name}`);
  const after = CODE.slice(start);
  const end = after.indexOf("\n}\n");
  return end === -1 ? after : after.slice(0, end);
}

const ready = (line: number): ImportRow => ({
  line,
  employeeCode: `E00${line}`,
  name: `Person ${line}`,
  errors: [],
  employee: { employeeCode: `E00${line}`, firstName: `Person${line}`, joiningDate: "2026-04-01" },
});

const broken = (line: number): ImportRow => ({
  line,
  employeeCode: "",
  name: `Person ${line}`,
  errors: ["Employee Code is blank."],
});

function planOf(rows: ImportRow[], over: Partial<ImportPlan> = {}): ImportPlan {
  return {
    rows,
    readyCount: rows.filter((r) => r.employee).length,
    errorCount: rows.filter((r) => !r.employee).length,
    unknownColumns: [],
    missingColumns: [],
    ...over,
  };
}

describe("decideImportCommit", () => {
  it("refuses a file with bad rows unless the caller asked to skip them", () => {
    const plan = planOf([ready(2), broken(3), ready(4)]);

    const refused = decideImportCommit(plan);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.refusal).toContain("1 of 3 rows have problems");
  });

  it("does not assume the caller wants the good half", () => {
    // The flag has to be asked for. Defaulting it to true would turn a broken
    // spreadsheet into a partial import reported as a success: the screen says
    // "imported", nobody is told which people were dropped, and the gap is only
    // discovered when somebody is missing from a payroll run.
    const plan = planOf([ready(2), broken(3)]);

    for (const options of [undefined, {}, { skipRowsWithErrors: false }]) {
      const decision = decideImportCommit(plan, options);
      expect(decision.ok, JSON.stringify(options)).toBe(false);
    }
  });

  it("imports only the ready rows once skipping is asked for", () => {
    const decision = decideImportCommit(planOf([ready(2), broken(3), ready(4)]), {
      skipRowsWithErrors: true,
    });

    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    // created counts rows that carry an employee, not lines in the file, and
    // skipped is the plan's own error count — the two numbers the screen shows
    // and the audit row records.
    expect(decision.created).toBe(2);
    expect(decision.skipped).toBe(1);
    expect(decision.ready.map((r) => r.line)).toEqual([2, 4]);
    expect(decision.ready.every((r) => r.employee)).toBe(true);
  });

  it("refuses a blocked file even when skipping was asked for", () => {
    // `blocked` is the whole-file verdict — seats exhausted, required column
    // missing. Skipping bad rows is not an answer to it.
    const decision = decideImportCommit(
      planOf([ready(2)], { blocked: "There are no seats left, so none of these 1 people can be added." }),
      { skipRowsWithErrors: true },
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal).toContain("no seats left");
  });

  it("refuses a file with nothing importable in it", () => {
    const decision = decideImportCommit(planOf([broken(2), broken(3)]), {
      skipRowsWithErrors: true,
    });

    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal).toBe(
      "There is nothing in that file that can be imported.",
    );
  });

  it("fits the plan the domain actually produces", () => {
    // The hand-built plans above are only worth as much as their resemblance to
    // a real one, so this runs a file through the same two calls the commit makes.
    const parsed = parseCsv(
      "Employee Code,First Name,Joining Date\nE001,Asha,2026-04-01\n,Rahul,2026-04-01\n",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const lookups: ImportLookups = {
      departments: new Map(),
      designations: new Map(),
      workLocations: new Map(),
      shifts: new Map(),
      weeklyOffPatterns: new Map(),
      existingCodes: new Set(),
    };
    const plan = planEmployeeImport(parsed.table, lookups, { seatsRemaining: null });

    expect(decideImportCommit(plan).ok).toBe(false);
    const decision = decideImportCommit(plan, { skipRowsWithErrors: true });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect([decision.created, decision.skipped]).toEqual([1, 1]);
    expect(decision.ready[0]?.employee?.employeeCode).toBe("E001");
  });
});

describe("the commit rebuilds the plan from the file", () => {
  it("takes a file and three flags, and no rows", () => {
    type CommitOptions = NonNullable<Parameters<typeof commitEmployeeImport>[2]>;

    // The Record is the assertion `tsc` makes: an option added to the commit —
    // `rows`, `plan`, `employees`, anything the browser could fill in — fails to
    // compile until somebody names it here and asks whether a client should be
    // choosing it. That is the whole reason preview and commit are separate.
    const options: Record<keyof CommitOptions, true> = {
      skipRowsWithErrors: true,
      createLogins: true,
      loginRole: true,
    };
    expect(Object.keys(options).sort()).toEqual([
      "createLogins",
      "loginRole",
      "skipRowsWithErrors",
    ]);

    // And the payload itself is still text, not a parsed structure the caller
    // assembled: `string | ImportRow[]` would make this `false`.
    const csvIsTextOnly: Parameters<typeof commitEmployeeImport>[1] extends string ? true : false =
      true;
    expect(csvIsTextOnly).toBe(true);
  });

  it("parses and re-plans server-side before writing anything", () => {
    const commit = body("commitEmployeeImport");

    expect(commit).toMatch(/const table = parseOrThrow\(csv\)/);
    expect(commit).toMatch(/planEmployeeImport\(table, lookups, \{ seatsRemaining: remaining \}\)/);
    // The rows that get inserted come from the decision this function just made
    // about its own plan, never from `options`.
    expect(commit).toMatch(/const decision = decideImportCommit\(plan, options\)/);
  // And that the decision is what gets written. `const ready = plan.rows`
  // survives every other assertion here: the filtering happens, is correct, and
  // is then ignored -- which is exactly the shape of a row with errors reaching
  // `insertEmployee` on the skip-errors path.
  expect(commit).toMatch(/const ready = decision\.ready/);
    expect(commit).toMatch(/for \(const row of ready\)/);
    expect(commit).not.toMatch(/options\.(rows|plan|employees)/);
  });

  it("keeps the preview read-only", () => {
    const preview = body("previewEmployeeImport");
    expect(preview).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(preview).not.toMatch(/\$transaction\(/);
    expect(preview).not.toMatch(/writeAudit\(/);
  });
});

describe("the whole file lands or none of it does", () => {
  it("runs every insert inside the one transaction", () => {
    const commit = body("commitEmployeeImport");
    const transaction = commit.indexOf("prisma.$transaction(");

    expect(CODE.match(/\$transaction\(/g) ?? []).toHaveLength(1);
    expect(transaction).toBeGreaterThan(-1);
    expect(commit.indexOf("for (const row of ready)")).toBeGreaterThan(transaction);

    // The client the writes go through is the transaction's, not the module's.
    // `insertEmployee(prisma, ...)` would compile, would pass any test that
    // imports a clean file, and would leave half a roster behind on the first
    // duplicate employee code.
    expect(commit).toMatch(/insertEmployee\(tx, ctx,/);
    expect(commit).toMatch(/provisionEmployeeLogin\(tx, ctx,/);
    expect(commit).not.toMatch(/insertEmployee\(prisma/);
    expect(commit).not.toMatch(/provisionEmployeeLogin\(prisma/);
  });

  it("writes the audit row only once the transaction has returned", () => {
    const commit = body("commitEmployeeImport");
    // A rolled-back import must not leave behind a row saying it happened.
    expect(commit.indexOf("await writeAudit(ctx, {")).toBeGreaterThan(
      commit.indexOf("return issued;"),
    );
    expect(commit).toMatch(/created: decision\.created/);
    expect(commit).toMatch(/skipped: decision\.skipped/);
  });
});

/**
 * The caps every other way in has to satisfy.
 *
 * The importer used to hand its rows to `insertEmployee` as `input as never` --
 * a cast that tells the compiler to stop asking -- so `employeeSchema` never
 * ran on the spreadsheet path at all.
 */
describe("the schema applies to a spreadsheet too", () => {
  const withField = (field: string, value: unknown): ImportRow => ({
    ...ready(2),
    employee: { ...ready(2).employee!, [field]: value },
  });

  it("refuses a value longer than the column will take, naming the line", () => {
    const decision = decideImportCommit(planOf([withField("addressLine1", "x".repeat(300))]));
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal).toContain("Line 2");
    expect(decision.ok === false && decision.refusal).toContain("addressLine1");
  });

  it("refuses an email a spreadsheet would happily hold", () => {
    const decision = decideImportCommit(planOf([withField("workEmail", "not an address")]));
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.refusal).toContain("Line 2");
  });

  it("still accepts an ordinary row", () => {
    expect(decideImportCommit(planOf([ready(2)])).ok).toBe(true);
  });

  it("checks every row, not only the first", () => {
    const decision = decideImportCommit(
      planOf([ready(2), withField("addressLine1", "x".repeat(300))]),
    );
    expect(decision.ok).toBe(false);
  });
});

describe("what happens after the rows land", () => {
  it("attaches managers and sets pay outside the transaction, and audits afterwards", () => {
    const commit = body("commitEmployeeImport");
    const transactionEnd = commit.indexOf("return { credentials: issued, createdIds: ids };");

    expect(transactionEnd).toBeGreaterThan(-1);
    // Both open transactions of their own and neither takes a client, so
    // calling them inside the import's transaction would deadlock against it.
    expect(commit.indexOf("await attachReportingLine(ctx, {")).toBeGreaterThan(transactionEnd);
    expect(commit.indexOf("await saveSalaryProfile(ctx, employeeId, {")).toBeGreaterThan(
      transactionEnd,
    );
    expect(commit).not.toMatch(/attachReportingLine\(tx/);
    expect(commit).not.toMatch(/saveSalaryProfile\(tx/);
  });

  it("checks the salary permission before writing any pay", () => {
    const commit = body("commitEmployeeImport");
    const check = commit.indexOf('ctx.permissions.has("employee.salary.manage")');
    const write = commit.indexOf("await saveSalaryProfile(ctx, employeeId, {");

    // `employee.create` is HR's, `employee.salary.manage` is an Admin's. The
    // single-create route makes exactly this check, and a spreadsheet must not
    // be the way around it.
    expect(check).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(check);
  });

  it("does not let a failed manager or salary undo the import", () => {
    const commit = body("commitEmployeeImport");
    // Both loops catch, because the employees are already written by then and
    // the two things they are doing are recoverable from the product.
    expect(commit).toMatch(/warnings\.push\(/);
    expect((commit.match(/} catch \(error\) {/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("sends one notification for the file rather than one per person", () => {
    const commit = body("commitEmployeeImport");
    const notify = commit.indexOf("await notify.toOrgRoles(");
    const loop = commit.indexOf("for (const row of ready)");

    expect(notify).toBeGreaterThan(-1);
    // Inside the row loop it would be one per imported person -- two hundred
    // notifications burying every other one an HR manager has.
    expect(commit.slice(loop, notify)).toContain("const unmanaged = ready.length - managersLinked");
  });
});
