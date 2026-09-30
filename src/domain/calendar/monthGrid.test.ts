import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { WEEKDAY_INITIALS, leadingBlanks } from "./monthGrid";

/**
 * The per-employee calendar rendered a month straight into a seven-wide grid
 * with no leading offset, so the 1st always sat in the first column. Every
 * column was a different weekday depending on the month, which makes the one
 * question the calendar is opened for — "which days were the week offs" —
 * unanswerable. There was no weekday header either, because there could not
 * have been a correct one.
 */

describe("leadingBlanks", () => {
  it("puts a Monday first with nothing before it", () => {
    // 2026-06-01 is a Monday.
    expect(leadingBlanks("2026-06-01")).toBe(0);
  });

  it("pushes a Sunday to the end of the week, not the start", () => {
    // 2026-02-01 is a Sunday: six blanks, so it lands in the seventh column.
    expect(leadingBlanks("2026-02-01")).toBe(6);
  });

  it("walks through a week correctly", () => {
    // 2026-06-01 Mon … 2026-06-07 Sun
    const offsets = [1, 2, 3, 4, 5, 6, 7].map((d) =>
      leadingBlanks(`2026-06-0${d}`),
    );
    expect(offsets).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("returns 0 rather than NaN for a missing date", () => {
    // NaN blanks would render as no cells at all and silently un-align the
    // grid this function exists to align.
    expect(leadingBlanks(undefined)).toBe(0);
    expect(leadingBlanks(null)).toBe(0);
    expect(leadingBlanks("")).toBe(0);
    expect(leadingBlanks("not-a-date")).toBe(0);
  });

  it("has seven weekday initials, Monday first", () => {
    expect(WEEKDAY_INITIALS).toHaveLength(7);
    expect(WEEKDAY_INITIALS[0]).toBe("M");
    expect(WEEKDAY_INITIALS[6]).toBe("S");
  });
});

describe("the calendar uses it", () => {
  const code = readFileSync(path.resolve("src/components/attendance/MonthDetail.tsx"), "utf8");

  it("offsets the first day", () => {
    expect(code).toMatch(/leadingBlanks\(/);
  });

  it("shows a weekday header, which is only honest once the grid is aligned", () => {
    expect(code).toMatch(/WEEKDAY_INITIALS/);
  });
});

describe("the buttons are where somebody looks", () => {
  it("the employee page puts them in its header, not inside a card", () => {
    const page = readFileSync(
      path.resolve("src/app/(app)/employees/[id]/page.tsx"),
      "utf8",
    );
    const header = page.indexOf("<PageHeader");
    const grid = page.indexOf("lg:grid-cols-3");
    const detail = page.indexOf("<MonthDetail");
    expect(detail).toBeGreaterThan(header);
    expect(detail).toBeLessThan(grid);
  });
});
