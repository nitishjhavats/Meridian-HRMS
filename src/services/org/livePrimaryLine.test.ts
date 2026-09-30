import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Who is their manager now" is asked in one place.
 *
 * The profile page seeding its edit dialog, `updateEmployee` deciding whether
 * a manager change is a change, and `attachReportingLine` refusing a line
 * that starts before the one it replaces each carried their own copy of the
 * where-clause. Three copies agree until one is edited; then the dialog opens
 * on a different manager from the one the save compares against, and a
 * phone-number fix reassigns somebody again. `livePrimaryLine` is the query,
 * and this reads the source to check the callers go through it, because a
 * test over the helper alone stays green after the call to it is deleted.
 */

const STRUCTURE = "src/services/org/structure.ts";
const WRITE = "src/services/employees/write.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("livePrimaryLine holds the predicate", () => {
  const helper = bodyOf(STRUCTURE, "export async function livePrimaryLine");

  it("is the shared where-fragment, scoped to the tenant, with what both writers need", () => {
    expect(helper).toMatch(
      /reportingRelationship\.findFirst\(\{\s*where: \{ organizationId: ctx\.organizationId!, employeeId, \.\.\.LIVE_PRIMARY_LINE \}/,
    );
    expect(helper).toMatch(/select: \{ id: true, managerId: true, startDate: true \}/);
  });

  it("and nothing else in either file spells it out again", () => {
    for (const file of [STRUCTURE, WRITE]) {
      expect(code(file), file).not.toMatch(/type: "PRIMARY",\s*endDate: null/);
    }
  });
});

describe("the writers ask it rather than prisma", () => {
  it("attachReportingLine compares the new start against the line it replaces", () => {
    const block = bodyOf(STRUCTURE, "export async function attachReportingLine");
    expect(block).toMatch(/const current = await livePrimaryLine\(ctx, employee\.id\)/);
    expect(block).not.toMatch(/reportingRelationship\.findFirst/);
  });

  it("updateEmployee decides a manager change against it", () => {
    const block = bodyOf(WRITE, "export async function updateEmployee");
    expect(block).toMatch(/const current = await livePrimaryLine\(ctx, employeeId\)/);
    expect(block).not.toMatch(/reportingRelationship\.findFirst/);
  });
});

describe("updateEmployee reads an empty manager as nobody", () => {
  const block = bodyOf(WRITE, "export async function updateEmployee");

  it("normalises before branching, so \"\" never reaches attachReportingLine as an id", () => {
    // The schema admits "", `createEmployee` reads it as none, and the form's
    // own select is "" before it is null. Branched on as an id it found no
    // such employee and refused the whole edit with a 404.
    expect(block).toMatch(/const reportsTo = input\.reportsToEmployeeId \|\| null/);
    expect(block).toMatch(/if \(reportsTo === null\)/);
    expect(block).toMatch(/else if \(current\?\.managerId !== reportsTo\)/);
    expect(block).toMatch(/managerId: reportsTo,/);
    // The raw field is read once, to normalise, and never branched on again.
    const normalise = block.indexOf("const reportsTo =");
    const afterNormalise = block.slice(block.indexOf("\n", normalise));
    expect(afterNormalise).not.toMatch(/input\.reportsToEmployeeId/);
  });
});
