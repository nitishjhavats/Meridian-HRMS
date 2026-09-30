import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A month on its own is a month of this year.
 *
 * `whereFrom` in the analytics service builds its date range from the year
 * and ignores a month that arrives without one. So Year "All years" + Month
 * "March" + Apply gave every stat, both tables and the CSV as all-time totals,
 * under a form that showed March applied and a Clear button. Nothing said the
 * month needed a year. The page now settles the year before it asks for
 * anything, and shows the year it settled on.
 */

const PAGE = "src/app/(platform)/platform/revenue/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the revenue filter", () => {
  const page = code(PAGE);

  it("defaults a lone month to the current year before anything is queried", () => {
    expect(page).toMatch(
      /const year = params\.year \? Number\(params\.year\) : month != null \? thisYear : undefined;/,
    );
    // The settled values, not the raw parameters, are what every query and
    // the export link are built from.
    expect(page).toMatch(/const filters = \{\n\s*year,\n\s*month,/);
  });

  it("shows the year it settled on in the form", () => {
    const select = page.slice(page.indexOf('name="year"'), page.indexOf('name="month"'));
    expect(select).toMatch(/defaultValue=\{year != null \? String\(year\) : ""\}/);
    expect(select).not.toMatch(/params\.year/);
  });
});
