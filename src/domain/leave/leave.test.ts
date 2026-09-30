import { describe, expect, it } from "vitest";
import {
  type LeaveBalanceState,
  type LeaveSpan,
  accruedForRow,
  accruedSoFar,
  availableDays,
  bookedDaysByMonth,
  carryForwardAmount,
  chargeableDaysByMonth,
  clipSpanToMonth,
  countLeaveDays,
  monthsWorkedInYear,
  validateLeave,
} from "./index";

const span = (
  startDate: string,
  endDate: string,
  startDayPart: LeaveSpan["startDayPart"] = "FULL",
  endDayPart: LeaveSpan["endDayPart"] = "FULL",
): LeaveSpan => ({ startDate, endDate, startDayPart, endDayPart });

const calendar = (weekOffs: string[] = [], holidays: string[] = []) => ({
  weekOffs: new Set(weekOffs),
  holidays: new Set(holidays),
});

describe("countLeaveDays", () => {
  it("counts a plain run of working days", () => {
    expect(countLeaveDays(span("2026-03-02", "2026-03-06")).totalDays).toBe(5);
  });

  it("does not charge for week-offs inside the span", () => {
    // Fri to Mon across a Sunday off.
    const counted = countLeaveDays(span("2026-03-06", "2026-03-09"), calendar(["2026-03-08"]));
    expect(counted.totalDays).toBe(3);
    expect(counted.skipped).toEqual([{ date: "2026-03-08", reason: "WEEK_OFF" }]);
  });

  it("does not charge for holidays inside the span", () => {
    const counted = countLeaveDays(span("2026-03-02", "2026-03-04"), calendar([], ["2026-03-03"]));
    expect(counted.totalDays).toBe(2);
    expect(counted.skipped[0]?.reason).toBe("HOLIDAY");
  });

  it("takes half a day off each half-day end", () => {
    expect(countLeaveDays(span("2026-03-02", "2026-03-04", "SECOND_HALF")).totalDays).toBe(2.5);
    expect(countLeaveDays(span("2026-03-02", "2026-03-04", "FULL", "FIRST_HALF")).totalDays).toBe(2.5);
    expect(
      countLeaveDays(span("2026-03-02", "2026-03-04", "SECOND_HALF", "FIRST_HALF")).totalDays,
    ).toBe(2);
  });

  it("treats a single half day as half a day, not zero", () => {
    // Both ends are the same day; subtracting twice would cancel it out entirely.
    expect(countLeaveDays(span("2026-03-02", "2026-03-02", "FIRST_HALF", "FIRST_HALF")).totalDays).toBe(0.5);
  });

  it("ignores a half-day marker on an end that is not a working day", () => {
    // Starting "Sunday afternoon" really starts on Monday, so nothing is halved.
    const counted = countLeaveDays(
      span("2026-03-08", "2026-03-10", "SECOND_HALF"),
      calendar(["2026-03-08"]),
    );
    expect(counted.totalDays).toBe(2);
  });

  it("returns zero when the whole span is non-working", () => {
    const counted = countLeaveDays(
      span("2026-03-08", "2026-03-08"),
      calendar(["2026-03-08"]),
    );
    expect(counted.totalDays).toBe(0);
  });
});

describe("balances", () => {
  const base: LeaveBalanceState = {
    allocated: 12,
    accrued: 6,
    used: 2,
    carriedForward: 3,
    encashed: 0,
  };

  it("uses accrued days for an accruing type, not the full allocation", () => {
    expect(availableDays(base, true)).toBe(7);
  });

  it("uses the allocation for a non-accruing type", () => {
    expect(availableDays(base, false)).toBe(13);
  });

  it("accrues monthly but never past the annual allocation", () => {
    const input = { annualAllocation: 12, monthlyAccrual: 1, accrualMode: "MONTHLY" as const };
    expect(accruedSoFar({ ...input, monthsWorked: 5 })).toBe(5);
    expect(accruedSoFar({ ...input, monthsWorked: 30 })).toBe(12);
  });

  it("caps carry-forward at the type's limit and never goes negative", () => {
    expect(carryForwardAmount(base, true, true, 10)).toBe(7);
    expect(carryForwardAmount(base, true, true, 4)).toBe(4);
    expect(carryForwardAmount(base, true, false, 10)).toBe(0);
    expect(carryForwardAmount({ ...base, used: 99 }, true, true, 10)).toBe(0);
  });
});

/**
 * `LeaveBalance.accrued` is written when a row is created and never recomputed.
 * A row appears the first time leave is approved, and again when the year-end
 * carry-forward run writes next year's opening balance — so a monthly-accrual
 * type would otherwise sit at whatever it held on the day the row appeared, for
 * the rest of the year. These are the cases that stops.
 */
describe("accruedForRow", () => {
  const el = { annualAllocation: 15, monthlyAccrual: 1.25, accrualMode: "MONTHLY" as const };

  it("recomputes a monthly type rather than trusting a stored zero", () => {
    expect(accruedForRow(0, { ...el, monthsWorked: 8 })).toBe(10);
  });

  it("never cuts back a stored figure that is more generous", () => {
    expect(accruedForRow(12, { ...el, monthsWorked: 3 })).toBe(12);
  });

  it("leaves a non-accruing type's stored figure alone", () => {
    const annual = { annualAllocation: 12, monthlyAccrual: 0, accrualMode: "ANNUAL" as const };
    expect(accruedForRow(0, { ...annual, monthsWorked: 12 })).toBe(0);
  });

  it("computes outright when there is no row at all", () => {
    expect(accruedForRow(null, { ...el, monthsWorked: 4 })).toBe(5);
  });
});

describe("monthsWorkedInYear", () => {
  it("counts from January for somebody who joined earlier", () => {
    expect(monthsWorkedInYear(2026, "2019-07-15", "2026-09-08")).toBe(9);
  });

  it("counts from the joining month in the year somebody joined", () => {
    expect(monthsWorkedInYear(2026, "2026-04-01", "2026-09-08")).toBe(6);
  });

  it("counts a whole year once the year is behind us", () => {
    expect(monthsWorkedInYear(2025, "2019-07-15", "2026-09-08")).toBe(12);
  });

  it("counts nothing for a year that has not started", () => {
    expect(monthsWorkedInYear(2027, "2019-07-15", "2026-09-08")).toBe(0);
  });

  it("counts nothing for a year somebody joined after", () => {
    expect(monthsWorkedInYear(2024, "2026-04-01", "2026-09-08")).toBe(0);
  });
});

describe("validateLeave", () => {
  const rules = { allowHalfDay: true, maxConsecutive: null, noticeDays: 0, paid: true };
  type Overrides = Partial<Omit<Parameters<typeof validateLeave>[0], "rules">> & {
    rules?: Partial<Parameters<typeof validateLeave>[0]["rules"]>;
  };
  const check = (overrides: Overrides = {}) => {
    const s = overrides.span ?? span("2026-03-02", "2026-03-04");
    return validateLeave({
      span: s,
      counted: overrides.counted ?? countLeaveDays(s),
      rules: { ...rules, ...(overrides.rules ?? {}) },
      available: overrides.available ?? 10,
      today: overrides.today ?? "2026-03-01",
      existing: overrides.existing ?? [],
      monthly: overrides.monthly ?? null,
    });
  };

  it("passes a clean request", () => {
    expect(check()).toEqual([]);
  });

  it("rejects an end before the start, and says nothing else", () => {
    const problems = check({ span: span("2026-03-04", "2026-03-02") });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.code).toBe("END_BEFORE_START");
  });

  it("refuses more days than are available, naming both figures", () => {
    const problems = check({ available: 1 });
    expect(problems[0]?.code).toBe("INSUFFICIENT_BALANCE");
    expect(problems[0]?.message).toContain("1 day(s) left");
    expect(problems[0]?.message).toContain("needs 3");
  });

  it("ignores the balance for unpaid leave", () => {
    expect(check({ available: 0, rules: { paid: false } })).toEqual([]);
  });

  it("enforces the consecutive-day cap", () => {
    expect(check({ rules: { maxConsecutive: 2 } })[0]?.code).toBe("TOO_LONG");
  });

  it("enforces notice and names the earliest permissible start", () => {
    const problems = check({ rules: { noticeDays: 7 } });
    expect(problems[0]?.code).toBe("TOO_LATE");
    expect(problems[0]?.message).toContain("2026-03-08");
  });

  it("refuses half days when the type forbids them", () => {
    const s = span("2026-03-02", "2026-03-04", "SECOND_HALF");
    expect(
      check({ span: s, counted: countLeaveDays(s), rules: { allowHalfDay: false } })[0]?.code,
    ).toBe("HALF_DAY_NOT_ALLOWED");
  });

  it("catches an overlap with leave already booked", () => {
    const problems = check({ existing: [{ startDate: "2026-03-03", endDate: "2026-03-05" }] });
    expect(problems[0]?.code).toBe("OVERLAPS_EXISTING");
  });

  it("leads with the overlap when a pending request is what made the balance short", () => {
    // The clash is the actionable fact; "you have 1 day left" only puzzles.
    const problems = check({
      available: 1,
      existing: [{ startDate: "2026-03-03", endDate: "2026-03-05" }],
    });
    expect(problems[0]?.code).toBe("OVERLAPS_EXISTING");
    expect(problems.map((p) => p.code)).toContain("INSUFFICIENT_BALANCE");
  });

  it("reports every problem at once rather than one at a time", () => {
    const problems = check({ available: 0, rules: { maxConsecutive: 1, noticeDays: 30 } });
    expect(problems.map((p) => p.code).sort()).toEqual([
      "INSUFFICIENT_BALANCE",
      "TOO_LATE",
      "TOO_LONG",
    ]);
  });

  /**
   * The monthly cap. The seeded on-demand week off grants four a month, and
   * before this the four accrued into a pool that could be spent eight in one
   * month. Pending counts as well as approved, and a request that straddles a
   * month end is held to each month for only the days it puts there.
   */
  describe("the monthly cap", () => {
    it("passes when the month has room", () => {
      const problems = check({ monthly: { cap: 4, taken: { "2026-03": 1 } } });
      expect(problems).toEqual([]);
    });

    it("refuses when what is booked plus this request passes the cap, naming the cap and what is left", () => {
      const problems = check({ monthly: { cap: 4, taken: { "2026-03": 2 } } });
      expect(problems).toHaveLength(1);
      expect(problems[0]?.code).toBe("TOO_MANY_THIS_MONTH");
      expect(problems[0]?.message).toContain("at most 4 day(s) a month");
      expect(problems[0]?.message).toContain("2 already booked in March 2026 leaves 2");
      expect(problems[0]?.message).toContain("needs 3 there");
    });

    it("says nothing is left rather than a negative figure", () => {
      const problems = check({ monthly: { cap: 4, taken: { "2026-03": 5 } } });
      expect(problems[0]?.message).toContain("leaves 0");
    });

    it("lets a request land exactly on the cap", () => {
      expect(check({ monthly: { cap: 4, taken: { "2026-03": 1 } } })).toEqual([]);
    });

    it("is not applied when the type has no cap", () => {
      expect(check({ monthly: null })).toEqual([]);
      expect(check({})).toEqual([]);
    });

    it("holds a request that spans two months to each month for its own days only", () => {
      // 30 March to 2 April: two days in March, two in April.
      const s = span("2026-03-30", "2026-04-02");
      const counted = countLeaveDays(s);
      // Two already in March, three already in April, cap four: March has
      // room for the two, April does not.
      const problems = check({
        span: s,
        counted,
        monthly: { cap: 4, taken: { "2026-03": 2, "2026-04": 3 } },
      });
      expect(problems).toHaveLength(1);
      expect(problems[0]?.message).toContain("3 already booked in April 2026 leaves 1");
      expect(problems[0]?.message).toContain("needs 2 there");

      // And with April clear, the same request stands, although its four
      // days would have overflowed either month taken as a whole.
      expect(
        check({ span: s, counted, monthly: { cap: 4, taken: { "2026-03": 2, "2026-04": 2 } } }),
      ).toEqual([]);
    });
  });
});

/**
 * The arithmetic under the cap: which month each day of a request belongs to,
 * and how much of a booked request lands in a given month.
 */
describe("chargeableDaysByMonth", () => {
  it("puts a request that stays inside a month entirely in that month", () => {
    const s = span("2026-03-02", "2026-03-04");
    expect([...chargeableDaysByMonth(s, countLeaveDays(s))]).toEqual([["2026-03", 3]]);
  });

  it("splits a request across the month end by where each day falls", () => {
    const s = span("2026-03-30", "2026-04-02");
    expect([...chargeableDaysByMonth(s, countLeaveDays(s))]).toEqual([
      ["2026-03", 2],
      ["2026-04", 2],
    ]);
  });

  it("charges a half-day end to the month that end lands in", () => {
    const s = span("2026-03-31", "2026-04-01", "SECOND_HALF", "FIRST_HALF");
    expect([...chargeableDaysByMonth(s, countLeaveDays(s))]).toEqual([
      ["2026-03", 0.5],
      ["2026-04", 0.5],
    ]);
  });

  it("leaves a week-off inside the span out of the month it falls in", () => {
    // Sunday 5 April is not charged, so April carries only the Wednesday to Saturday.
    const s = span("2026-03-31", "2026-04-06");
    const counted = countLeaveDays(s, calendar(["2026-04-05"]));
    expect([...chargeableDaysByMonth(s, counted)]).toEqual([
      ["2026-03", 1],
      ["2026-04", 5],
    ]);
  });

  it("always adds up to the total the balance is charged", () => {
    const cases: LeaveSpan[] = [
      span("2026-03-02", "2026-03-02", "FIRST_HALF", "FIRST_HALF"),
      span("2026-03-30", "2026-04-02", "SECOND_HALF"),
      span("2026-03-30", "2026-04-02", "FULL", "FIRST_HALF"),
      span("2026-01-31", "2026-02-01", "SECOND_HALF", "FIRST_HALF"),
      span("2026-12-29", "2027-01-03"),
    ];
    for (const s of cases) {
      const counted = countLeaveDays(s, calendar(["2026-04-05", "2027-01-03"]));
      const sum = [...chargeableDaysByMonth(s, counted).values()].reduce((a, b) => a + b, 0);
      expect(sum).toBe(counted.totalDays);
    }
  });
});

describe("clipSpanToMonth", () => {
  it("returns null for a month the span does not touch", () => {
    expect(clipSpanToMonth(span("2026-03-02", "2026-03-04"), 2026, 4)).toBeNull();
    expect(clipSpanToMonth(span("2026-03-02", "2026-03-04"), 2026, 2)).toBeNull();
  });

  it("leaves a span inside the month exactly as it is", () => {
    const s = span("2026-03-02", "2026-03-04", "SECOND_HALF", "FIRST_HALF");
    expect(clipSpanToMonth(s, 2026, 3)).toEqual(s);
  });

  it("cuts a straddling span at the month end and makes the cut end a whole day", () => {
    const s = span("2026-03-30", "2026-04-02", "SECOND_HALF", "FIRST_HALF");
    expect(clipSpanToMonth(s, 2026, 3)).toEqual(span("2026-03-30", "2026-03-31", "SECOND_HALF", "FULL"));
    expect(clipSpanToMonth(s, 2026, 4)).toEqual(span("2026-04-01", "2026-04-02", "FULL", "FIRST_HALF"));
  });

  it("keeps only the middle month of a span that covers a whole one", () => {
    const s = span("2026-03-31", "2026-05-01");
    expect(clipSpanToMonth(s, 2026, 4)).toEqual(span("2026-04-01", "2026-04-30"));
  });
});

describe("bookedDaysByMonth", () => {
  it("counts a booked request in the month it sits in, and nothing elsewhere", () => {
    const taken = bookedDaysByMonth([span("2026-03-02", "2026-03-04")], ["2026-03", "2026-04"]);
    expect(taken).toEqual({ "2026-03": 3, "2026-04": 0 });
  });

  it("gives a straddling request to each month for its own days", () => {
    const taken = bookedDaysByMonth(
      [span("2026-03-30", "2026-04-02", "SECOND_HALF", "FIRST_HALF")],
      ["2026-03", "2026-04"],
    );
    expect(taken).toEqual({ "2026-03": 1.5, "2026-04": 1.5 });
  });

  it("adds several requests up and skips the rest days between them", () => {
    const taken = bookedDaysByMonth(
      [span("2026-03-06", "2026-03-09"), span("2026-03-20", "2026-03-20", "FIRST_HALF", "FIRST_HALF")],
      ["2026-03"],
      calendar(["2026-03-08"]),
    );
    expect(taken).toEqual({ "2026-03": 3.5 });
  });
});
