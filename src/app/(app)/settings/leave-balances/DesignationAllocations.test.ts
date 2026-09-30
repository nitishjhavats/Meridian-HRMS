import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Week off" was three numbers on three screens under one name, and the
 * designation grid showed two of them side by side: a leave-type column for
 * the on-demand week off (a bank of extra rest days, allocated per person) and
 * "week offs a month" (the paid quota payroll measures rest days against).
 * Filling in the wrong one was the natural mistake, and nothing said which was
 * which.
 *
 * There is no pure function to test — the defect is which rows a service
 * fetches and what a heading says — so these read the source. Each assertion
 * is one half of the fix: the on-demand type stays out of the grid at the
 * service, the quota column and the payroll rule say where they sit in the
 * ladder, and the grid does not vanish for an organisation whose only active
 * leave type is the one that is deliberately not a column.
 */

const SERVICE = "src/services/leave/designationAllocation.ts";
const GRID = "src/app/(app)/settings/leave-balances/DesignationAllocations.tsx";
const RULES = "src/app/(app)/payroll/rules/RuleEditor.tsx";

/** Comments stripped, so a rule quoted in prose cannot pass for a rule in code. */
function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** One JSX element's source, opening tag to its closing tag. */
function element(body: string, open: string, close: string, after = 0): string {
  const start = body.indexOf(open, after);
  expect(start, `no ${open}`).toBeGreaterThan(-1);
  const end = body.indexOf(close, start);
  expect(end, `unterminated ${open}`).toBeGreaterThan(start);
  return body.slice(start, end + close.length);
}

describe("the on-demand week off is not a designation column", () => {
  it("the view fetches only leave types that are not the week-off type", () => {
    const service = code(SERVICE);
    const query = element(service, "prisma.leaveType.findMany(", "})");
    // `active: true` alone would list it: the seeded type is active in every
    // organisation, and it is the *only* active type in a new one.
    expect(query).toMatch(/where:\s*\{[^}]*isWeekOff:\s*false/);
  });

  it("the writer refuses it, so the route cannot land a figure the grid does not show", () => {
    const service = code(SERVICE);
    const writer = service.slice(service.indexOf("export async function setDesignationAllocation"));
    expect(writer).toMatch(/select:\s*\{\s*id:\s*true,\s*code:\s*true,\s*isWeekOff:\s*true\s*\}/);
    // A figure is refused; clearing one (`days: null`) is not, so a row from
    // before the column went can still be removed.
    expect(writer).toMatch(/if \(type\.isWeekOff && input\.days !== null\) \{\s*throw new ValidationError\(/);
    expect(writer).toMatch(/allocated per person on the balance grid, not by designation/);
  });

  it("the grid client never renders a week-off leave type on its own", () => {
    // The client trusts the service's list. If it grew its own filter the two
    // could disagree; if it grew none and the service lost its filter, the
    // column would be back. This pins the one place the decision lives.
    expect(code(GRID)).not.toMatch(/isWeekOff/);
  });
});

describe("the grid stays up for the paid quota alone", () => {
  it("waits for designations, not for leave types", () => {
    const grid = code(GRID);
    expect(grid).toMatch(/if \(data\.designations\.length === 0\) \{/);
    // A new organisation has exactly one active leave type and it is the
    // on-demand week off, so gating on `types.length` would hide the quota
    // column exactly when it is the only thing there is to set.
    expect(grid).not.toMatch(/data\.types\.length === 0/);
  });
});

describe("the paid quota column says where it sits", () => {
  it("is headed as the paid quota, not as a leave type", () => {
    const grid = code(GRID);
    const heading = element(grid, '<span className="block">Paid week offs</span>', "</th>");
    expect(heading).toMatch(/a month/);
    expect(grid).toMatch(/aria-label=\{`Paid week offs a month for \$\{designation\.title\}`\}/);
  });

  it("is captioned as overriding the rule and overridden by the person", () => {
    const grid = code(GRID);
    const caption = element(grid, "<p className=\"mt-3 text-xs text-muted-foreground\">", "</p>");
    expect(caption).toMatch(/overrides the payroll rule/);
    expect(caption).toMatch(/own number on their profile\s+overrides it/);
    expect(caption).toMatch(/on-demand week off is not a column/);
    expect(caption).toMatch(/allocated per person in the grid above/);
  });

  it("clearing a cell still says it goes back to the rule", () => {
    expect(code(GRID)).toMatch(/weekOffsPerMonth === null \? "Back to the payroll rule\."/);
  });
});

describe("the payroll rule names the layers above it", () => {
  it("the quota hint says a designation or a person can override it", () => {
    const rules = code(RULES);
    const field = element(rules, 'htmlFor="weekOffQuota"', "/>");
    expect(field).toMatch(/hint="[^"]*a designation or a person can override this/);
    // The pattern fallback is still the first thing it says: an empty field
    // meaning "however many the roster gives" is the part people get wrong.
    expect(field).toMatch(/hint="Leave it empty to give whatever the weekly-off pattern gives\./);
  });
});
