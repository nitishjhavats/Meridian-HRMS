import { describe, expect, it } from "vitest";
import { daysInMonth } from "../date";
import { DEFAULT_PAYROLL_POLICY } from "./policy";
import { sampleMonthInput } from "./sample";
import { simulatePayroll } from "./simulate";

const rupees = (n: number) => n * 100;

/** March 2026 has 31 days and 5 Sundays. */
const MARCH = { totalDays: 31, weekOffDays: 5 };

describe("the month a sample payslip describes", () => {
  it("takes its period from today, not from a fixed month", () => {
    const input = sampleMonthInput(rupees(40_000), "2026-03-17", MARCH);
    expect(input.year).toBe(2026);
    expect(input.month).toBe(3);
  });

  it("describes exactly as many days as the month has", () => {
    // `simulatePayroll` fills its ledger in order and stops at the length of the
    // month, so a day too many drops week-offs off the end and the payslip
    // claims rest days the person never got.
    const input = sampleMonthInput(rupees(40_000), "2026-03-17", MARCH);
    expect((input.presentDays ?? 0) + (input.weekOffDays ?? 0)).toBe(daysInMonth(2026, 3));

    const { unallocatedDays } = simulatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(unallocatedDays).toBe(0);
  });

  it("works every day that is not a rest day", () => {
    const input = sampleMonthInput(rupees(40_000), "2026-03-17", MARCH);
    expect(input.presentDays).toBe(26);
    expect(input.weekOffDays).toBe(5);
  });

  it("describes nothing that would take money off", () => {
    // A sample carrying invented absences, lates or an advance answers a
    // question nobody asked, and makes a real payslip impossible to compare
    // against later.
    const input = sampleMonthInput(rupees(40_000), "2026-03-17", MARCH);
    expect(input.absentDays ?? 0).toBe(0);
    expect(input.halfDays ?? 0).toBe(0);
    expect(input.unpaidLeaveDays ?? 0).toBe(0);
    expect(input.lateCount ?? 0).toBe(0);
    expect(input.earlyLeaveCount ?? 0).toBe(0);
    expect(input.advancePaise ?? 0).toBe(0);
    expect(input.adjustments ?? []).toHaveLength(0);
    expect(input.training).toBeUndefined();
  });

  it("takes the rest days it is given rather than assuming Sundays", () => {
    // A five-day week is nine rest days in a 31-day month, and an organisation
    // on one would otherwise be shown a payslip claiming 26 days worked.
    const input = sampleMonthInput(rupees(40_000), "2026-03-17", { totalDays: 31, weekOffDays: 9 });
    expect(input.presentDays).toBe(22);
    expect(input.weekOffDays).toBe(9);
  });

  it("survives a pattern that marks every day a rest day", () => {
    // Negative present days would leave the ledger empty, which the engine
    // reads as a month with nothing in it — and pays in full.
    const input = sampleMonthInput(rupees(40_000), "2026-03-17", { totalDays: 31, weekOffDays: 40 });
    expect(input.presentDays).toBe(0);
    expect(input.weekOffDays).toBe(31);
  });
});

describe("the figures the sample carries", () => {
  it("pays a full month at the employee's own CTC", () => {
    const { result } = simulatePayroll(
      sampleMonthInput(rupees(40_000), "2026-03-17", MARCH),
      DEFAULT_PAYROLL_POLICY,
    );
    expect(result.netPaise).toBe(rupees(40_000));
    expect(result.days.payableDays).toBe(result.days.basisDays);
  });

  it("pays a full month on a five-day week too", () => {
    // The basis changes with the rest days under some policies; the point of a
    // clean month is that whatever the basis, nothing is prorated away.
    const { result } = simulatePayroll(
      sampleMonthInput(rupees(40_000), "2026-03-17", { totalDays: 31, weekOffDays: 9 }),
      DEFAULT_PAYROLL_POLICY,
    );
    expect(result.netPaise).toBe(rupees(40_000));
    expect(result.days.payableDays).toBe(result.days.basisDays);
  });

  it("pays a full month under every payable-days basis", () => {
    for (const basis of ["CALENDAR_DAYS", "FIXED_30", "WORKING_DAYS", "WORKING_DAYS_PLUS_PAID_OFF"] as const) {
      const { result } = simulatePayroll(sampleMonthInput(rupees(40_000), "2026-03-17", MARCH), {
        ...DEFAULT_PAYROLL_POLICY,
        payableDaysBasis: basis,
      });
      expect(result.days.payableDays, basis).toBe(result.days.basisDays);
      expect(result.netPaise, basis).toBe(rupees(40_000));
    }
  });

  it("is zero for somebody whose recorded CTC is zero, rather than a round figure", () => {
    // The old admin sample invented ₹30,000 of basic for everyone. If a record
    // says nothing, the sample says nothing — the service refuses to render one
    // at all, and this pins that there is no invented floor underneath it.
    const { result } = simulatePayroll(
      sampleMonthInput(0, "2026-03-17", MARCH),
      DEFAULT_PAYROLL_POLICY,
    );
    expect(result.netPaise).toBe(0);
  });
});
