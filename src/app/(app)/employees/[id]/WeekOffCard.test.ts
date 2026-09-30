import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { employeeSchema } from "@/services/employees/schema";

/**
 * The Week off card writes through the employee PATCH, and the PATCH accepts
 * what it writes.
 *
 * Both halves are pinned because each has failed on its own before: a form
 * that sent a field the update object never carried (`confirmationDate`),
 * and a column the create path wrote that no edit could change. The card's
 * two new fields go through the same route as every other employee edit --
 * one permission, one audit entry, one place the days are validated.
 */

const CARD = "src/app/(app)/employees/[id]/WeekOffCard.tsx";
const PROFILE = "src/app/(app)/employees/[id]/page.tsx";
const WRITE = "src/services/employees/write.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the card posts through the employee PATCH", () => {
  it("both fields, and the pattern, in one request", () => {
    const card = code(CARD);
    const patch = card.slice(card.indexOf("api(`/api/employees/${employeeId}`"));
    expect(patch).toMatch(/method: "PATCH"/);
    expect(patch.slice(0, 400)).toMatch(/weeklyOffConfig: outgoing/);
    expect(patch.slice(0, 400)).toMatch(/weeklyOffPatternId: patternId \|\| null/);
    expect(patch.slice(0, 400)).toMatch(/weekOffsPerMonth: quota/);
    // No second route, no direct write.
    expect(card).not.toMatch(/prisma/);
    expect(card).not.toMatch(/\/api\/employees\/\$\{employeeId\}\/week/);
  });

  it("goes through mutate, so a refusal is a toast rather than a silent nothing", () => {
    expect(code(CARD)).toMatch(/await mutate\(\s*\(\) =>\s*api\(`\/api\/employees\/\$\{employeeId\}`/);
  });

  it("is editable only with employee.update, which the page decides", () => {
    const page = code(PROFILE);
    expect(page).toMatch(/const canEdit = hasPermission\(ctx, "employee\.update"\)/);
    expect(page).toMatch(/<WeekOffCard[\s\S]*?canEdit=\{canEdit\}/);
    expect(code(CARD)).toMatch(/props\.canEdit \? <Editor \{\.\.\.props\} \/> : <Summary \{\.\.\.props\} \/>/);
  });

  it("the page works out the two fallbacks server-side and passes them down", () => {
    const page = code(PROFILE);
    expect(page).toMatch(/designationQuota=\{employee\.designation\?\.weekOffsPerMonth \?\? null\}/);
    expect(page).toMatch(/policyQuota=\{payroll \? payroll\.policy\.weekOff\.quotaPerMonth : undefined\}/);
    expect(page).toMatch(/getPayrollPolicy\(ctx\)/);
    expect(page).toMatch(/weeklyOffChoices\(ctx\)/);
    expect(page).not.toMatch(/prisma\./);
  });

  it("the old 'Not set' is gone: organisation default is named as such", () => {
    const page = code(PROFILE);
    expect(page).toMatch(/`Organisation default \(\$\{weekOffChoices\.organisationDefaultSummary\}\)`/);
    expect(page).not.toMatch(/: "Not set"\s*\}\s*\/>\s*<Row\s+icon=\{Users\}/);
  });
});

describe("and the PATCH accepts what the card sends", () => {
  const partial = employeeSchema.partial();

  it("their own days, or null to follow the pattern", () => {
    expect(partial.safeParse({ weeklyOffConfig: { type: "MULTIPLE", days: [2, 5] } }).success).toBe(true);
    expect(partial.safeParse({ weeklyOffConfig: null }).success).toBe(true);
    expect(partial.safeParse({ weeklyOffConfig: { type: "ROTATIONAL", days: [0] } }).success).toBe(false);
    expect(partial.safeParse({ weeklyOffConfig: { type: "FIXED", days: ["Sunday"] } }).success).toBe(false);
  });

  it("a quota between 0 and 31, or null to fall through", () => {
    expect(partial.safeParse({ weekOffsPerMonth: 4 }).success).toBe(true);
    expect(partial.safeParse({ weekOffsPerMonth: 0 }).success).toBe(true);
    expect(partial.safeParse({ weekOffsPerMonth: null }).success).toBe(true);
    expect(partial.safeParse({ weekOffsPerMonth: 32 }).success).toBe(false);
    expect(partial.safeParse({ weekOffsPerMonth: 2.5 }).success).toBe(false);
  });

  it("and the write validates the days and writes both columns", () => {
    const write = code(WRITE);
    expect(write).toMatch(/personalWeeklyOffErrors\(input\.weeklyOffConfig\.days\)/);
    expect(write).toMatch(/weeklyOffConfig: Prisma\.DbNull/);
    expect(write).toMatch(/weeklyOffConfig: personalWeeklyOff\(input\.weeklyOffConfig\.days\)/);
    // In the update object, not only on create.
    const update = write.slice(write.indexOf("export async function updateEmployee"));
    expect(update).toMatch(/\.\.\.personalWeeklyOffPatch\(input\)/);
    expect(update).toMatch(/weekOffsPerMonth: input\.weekOffsPerMonth \?\? null/);
  });
});
