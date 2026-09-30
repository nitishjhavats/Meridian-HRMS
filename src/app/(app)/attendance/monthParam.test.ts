import { describe, expect, it } from "vitest";

import { resolveMonthParam } from "./monthParam";

/**
 * `/attendance?year=2026&month=13` used to reach `getMonthlyGrid`, which threw
 * "That is not a month." into the generic error page. The arrows never write
 * such a URL; a person editing the address bar does, and they should land on
 * this month, not on "Something went wrong".
 */

const TODAY = "2026-09-14";
const CURRENT = { year: 2026, month: 9 };

describe("resolveMonthParam", () => {
  it("passes a real month through", () => {
    expect(resolveMonthParam({ year: "2026", month: "3" }, TODAY)).toEqual({ year: 2026, month: 3 });
    expect(resolveMonthParam({ year: "2026", month: "12" }, TODAY)).toEqual({ year: 2026, month: 12 });
    expect(resolveMonthParam({ year: "2000", month: "1" }, TODAY)).toEqual({ year: 2000, month: 1 });
  });

  it("is the current month with no parameters at all", () => {
    expect(resolveMonthParam({}, TODAY)).toEqual(CURRENT);
    expect(resolveMonthParam({ year: "", month: "" }, TODAY)).toEqual(CURRENT);
  });

  it("falls back to the current month when the month is not one", () => {
    expect(resolveMonthParam({ year: "2026", month: "13" }, TODAY)).toEqual(CURRENT);
    expect(resolveMonthParam({ year: "2026", month: "0" }, TODAY)).toEqual(CURRENT);
    expect(resolveMonthParam({ year: "2026", month: "-1" }, TODAY)).toEqual(CURRENT);
    expect(resolveMonthParam({ year: "2026", month: "1.5" }, TODAY)).toEqual(CURRENT);
    expect(resolveMonthParam({ year: "2026", month: "March" }, TODAY)).toEqual(CURRENT);
  });

  it("and when the year would make `new Date` invalid", () => {
    // `daysInMonth(999999, 3)` is NaN: no dates, and the range query fell over.
    expect(resolveMonthParam({ year: "999999", month: "3" }, TODAY)).toEqual(CURRENT);
    expect(resolveMonthParam({ year: "1999", month: "3" }, TODAY)).toEqual(CURRENT);
    expect(resolveMonthParam({ year: "abc", month: "3" }, TODAY)).toEqual(CURRENT);
  });

  it("discards both halves when one is bad, not the good one alone", () => {
    // March of an impossible year is not a month either; and a bad month with
    // a good year must not become "that year, this month" — a page the arrows
    // could never have led to.
    expect(resolveMonthParam({ year: "2024", month: "13" }, TODAY)).toEqual(CURRENT);
    expect(resolveMonthParam({ year: "99999", month: "2" }, TODAY)).toEqual(CURRENT);
  });

  it("a month on its own means this year", () => {
    expect(resolveMonthParam({ month: "2" }, TODAY)).toEqual({ year: 2026, month: 2 });
    expect(resolveMonthParam({ year: "2025" }, TODAY)).toEqual({ year: 2025, month: 9 });
  });
});
