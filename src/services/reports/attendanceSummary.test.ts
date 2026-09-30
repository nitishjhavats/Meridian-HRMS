import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attendanceSummaryWindow } from "./index";

/**
 * The attendance summary covers one month — and only that month.
 *
 * Its end used to be the literal `-31`. `new Date("2026-02-31T00:00:00.000Z")`
 * is not an invalid date in V8, it is 3 March, so February's summary counted
 * three days of March, and every 30-day month counted the 1st of the next.
 * The preview and the CSV share the rows, so they agreed with each other and
 * nobody noticed until the register did not reconcile.
 *
 * One case per month length, plus a leap year, because a fix that reads the
 * calendar has to be right for every shape the calendar takes.
 */

describe("the attendance summary's month window", () => {
  it("ends February on the 28th", () => {
    expect(attendanceSummaryWindow(2026, 2)).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });

  it("ends a leap-year February on the 29th", () => {
    expect(attendanceSummaryWindow(2024, 2)).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  });

  it("ends a thirty-day month on the 30th", () => {
    expect(attendanceSummaryWindow(2026, 4)).toEqual({ start: "2026-04-01", end: "2026-04-30" });
    expect(attendanceSummaryWindow(2026, 9)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });

  it("still ends a thirty-one-day month on the 31st", () => {
    expect(attendanceSummaryWindow(2026, 1)).toEqual({ start: "2026-01-01", end: "2026-01-31" });
    expect(attendanceSummaryWindow(2026, 12)).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("never lands in the following month once parsed the way the query parses it", () => {
    // The service turns each bound into `new Date(`${day}T00:00:00.000Z`)`;
    // this is the exact check the old literal failed.
    for (let month = 1; month <= 12; month += 1) {
      const { end } = attendanceSummaryWindow(2026, month);
      const parsed = new Date(`${end}T00:00:00.000Z`);
      expect(parsed.getUTCMonth() + 1, `month ${month}`).toBe(month);
    }
  });
});

/**
 * Wiring, guarded at the source: the summary reads its bounds from the window
 * above and not from a literal, and the API honours the organisation-wide
 * Reports switch that the screen and the nav already honour.
 */
const SOURCE = readFileSync(path.resolve("src/services/reports/index.ts"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

describe("the report service", () => {
  it("takes the summary's bounds from the calendar", () => {
    expect(SOURCE).toMatch(/const \{ start, end \} = attendanceSummaryWindow\(year, month\)/);
    expect(SOURCE).not.toMatch(/padStart\(2, "0"\)\}-31`/);
  });

  it("refuses every report when the Reports module is switched off", () => {
    // After the permission and before the per-report module: a bookmarked
    // `/api/reports/attendance-summary?...` must stop working the moment
    // Settings > Modules turns Reports off, exactly as `/reports` does.
    expect(SOURCE).toMatch(
      /requirePermission\(ctx, "report\.export"\);\s*requireModule\(ctx, "reports"\);/,
    );
  });

  it("and offers none to the picker in that case either", () => {
    expect(SOURCE).toMatch(/if \(!ctx\.modules\.has\("reports"\)\) return \[\];/);
  });
});
