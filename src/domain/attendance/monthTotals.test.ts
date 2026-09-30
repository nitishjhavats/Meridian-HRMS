import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  MONTHS_BACK,
  countDay,
  emptyMonthTotals,
  shiftMonth,
  withinWindow,
  workingDays,
} from "./monthTotals";

/**
 * The same eight statuses were tallied in three places with three sets of field
 * names. Two of them now ask this; the payroll engine keeps its own, on purpose,
 * because it counts in *payable days* with a half-day factor — a different
 * question with a different answer.
 */

describe("countDay", () => {
  it("counts every kind of present day as present", () => {
    const totals = emptyMonthTotals();
    for (const status of ["FULL_DAY", "EXTRA_DAY", "TRAINING_DAY", "ON_DUTY", "CHECKED_IN"] as const) {
      countDay(totals, status);
    }
    expect(totals.present).toBe(5);
  });

  it("a day in progress counts as present", () => {
    // Somebody who has checked in and not yet out is at work. Before the status
    // existed the row read HALF_DAY from the moment they arrived; without this
    // branch it would read as not marked, which is one day short on the tile
    // the person looks at while they are still in the building.
    const totals = emptyMonthTotals();
    countDay(totals, "CHECKED_IN");
    expect(totals).toMatchObject({ present: 1, halfDays: 0, notMarked: 0 });
  });

  it("splits leave into paid and unpaid while keeping the combined figure", () => {
    const totals = emptyMonthTotals();
    countDay(totals, "PAID_LEAVE");
    countDay(totals, "PAID_LEAVE");
    countDay(totals, "UNPAID_LEAVE");
    expect(totals).toMatchObject({ leave: 3, paidLeave: 2, unpaidLeave: 1 });
  });

  it("treats a day off as a week off, because to the person it is one", () => {
    const totals = emptyMonthTotals();
    countDay(totals, "WEEK_OFF");
    countDay(totals, "DAY_OFF");
    expect(totals.weekOff).toBe(2);
  });

  it("counts a half day as neither present nor absent", () => {
    const totals = emptyMonthTotals();
    countDay(totals, "HALF_DAY");
    expect(totals).toMatchObject({ halfDays: 1, present: 0, absent: 0 });
  });

  it("counts lateness alongside the status, not instead of it", () => {
    const totals = emptyMonthTotals();
    countDay(totals, "FULL_DAY", 20);
    expect(totals).toMatchObject({ present: 1, lateCount: 1 });
  });

  it("falls through to not-marked rather than silently dropping a day", () => {
    const totals = emptyMonthTotals();
    countDay(totals, "NOT_MARKED");
    expect(totals.notMarked).toBe(1);
  });

  it("every branch adds exactly one day somewhere", () => {
    // The property that matters: a month of 30 days must tally to 30, whatever
    // the statuses are. A missed branch silently loses days from every report.
    const statuses = [
      "FULL_DAY", "EXTRA_DAY", "TRAINING_DAY", "ON_DUTY", "HALF_DAY", "ABSENT",
      "PAID_LEAVE", "UNPAID_LEAVE", "WEEK_OFF", "DAY_OFF", "HOLIDAY", "NOT_MARKED",
      "CHECKED_IN",
    ] as const;
    const totals = emptyMonthTotals();
    for (const status of statuses) countDay(totals, status);
    const counted =
      totals.present + totals.halfDays + totals.absent + totals.leave +
      totals.weekOff + totals.holiday + totals.notMarked;
    expect(counted).toBe(statuses.length);
  });
});

describe("workingDays", () => {
  it("excludes rest days and holidays, which nobody was going to work", () => {
    const totals = emptyMonthTotals();
    totals.weekOff = 4;
    totals.holiday = 2;
    expect(workingDays(30, totals)).toBe(24);
  });

  it("never goes below zero", () => {
    const totals = emptyMonthTotals();
    totals.weekOff = 40;
    expect(workingDays(30, totals)).toBe(0);
  });
});

describe("the three-month window", () => {
  const now = { year: 2026, month: 9 };

  it("allows this month", () => {
    expect(withinWindow({ year: 2026, month: 9 }, now)).toBe(true);
  });

  it("allows exactly three months back, and not four", () => {
    expect(withinWindow({ year: 2026, month: 6 }, now)).toBe(true);
    expect(withinWindow({ year: 2026, month: 5 }, now)).toBe(false);
  });

  it("refuses the future — there is nothing recorded there", () => {
    expect(withinWindow({ year: 2026, month: 10 }, now)).toBe(false);
  });

  it("crosses a year boundary without arithmetic going wrong", () => {
    const january = { year: 2027, month: 1 };
    expect(withinWindow({ year: 2026, month: 10 }, january)).toBe(true);
    expect(withinWindow({ year: 2026, month: 9 }, january)).toBe(false);
  });

  it("is three months, and says so", () => {
    expect(MONTHS_BACK).toBe(3);
  });
});

describe("shiftMonth", () => {
  it("steps back over January into the previous December", () => {
    expect(shiftMonth({ year: 2027, month: 1 }, -1)).toEqual({ year: 2026, month: 12 });
  });

  it("steps forward over December into the next January", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });

  it("round-trips", () => {
    const start = { year: 2026, month: 3 };
    expect(shiftMonth(shiftMonth(start, -5), 5)).toEqual(start);
  });
});

describe("the callers", () => {
  const read = (p: string) => readFileSync(path.resolve(p), "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("the admin grid keeps no private copy of the buckets", () => {
    const code = strip(read("src/services/attendance/admin.ts"));
    expect(code).toMatch(/countDay\(totals, status/);
    expect(code).not.toMatch(/PRESENT_STATUSES: AttendanceStatus\[\] =/);
  });

  it("the reception screen asks the same function", () => {
    expect(strip(read("src/services/attendance/kiosk.ts"))).toMatch(/countDay\(totals, status/);
  });

  it("the reception screen is bounded to the window and to its own roster", () => {
    const code = strip(read("src/services/attendance/kiosk.ts"));
    expect(code).toMatch(/withinWindow\(cursor, nowCursor\)/);
    // A device holds no read permission at all, so the scope has to be the
    // roster it can already mark rather than a permission it does not have.
    expect(code).toMatch(/workLocationId: device\.workLocation\.id/);
  });

  it("both month pickers stop at the same edge", () => {
    for (const file of [
      "src/components/attendance/MonthDetail.tsx",
      "src/app/kiosk/KioskMonth.tsx",
    ]) {
      const code = strip(read(file));
      expect(code).toMatch(/canGoBack/);
      expect(code).toMatch(/canGoForward/);
    }
  });
});
