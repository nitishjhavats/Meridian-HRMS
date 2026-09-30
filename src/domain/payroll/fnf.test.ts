import { describe, expect, it } from "vitest";
import { DEFAULT_FNF_POLICY, type FnfInput, type FnfPolicy, computeFnf, yearsOfService } from "./fnf";
import { DEFAULT_PAYROLL_POLICY } from "./policy";
import { simulatePayroll } from "./simulate";

const rupees = (n: number) => n * 100;

function fnfPolicyWith(patch: (p: FnfPolicy) => void): FnfPolicy {
  const copy = structuredClone(DEFAULT_FNF_POLICY) as FnfPolicy;
  patch(copy);
  return copy;
}

function input(overrides: Partial<FnfInput> = {}): FnfInput {
  return {
    employee: { id: "emp_1", name: "Exiting Employee", joinedOn: "2020-01-01" },
    lastWorkingDay: "2026-04-30",
    finalSalaryPaise: rupees(30_000),
    basisComponentMonthlyPaise: rupees(30_000),
    leaveBalances: [],
    noticeDaysRequired: 30,
    noticeDaysServed: 30,
    advanceOutstandingPaise: 0,
    assetRecoveryPaise: 0,
    adjustments: [],
    ...overrides,
  };
}

const line = (result: ReturnType<typeof computeFnf>, code: string) =>
  result.lines.find((l) => l.code === code);

describe("full and final settlement", () => {
  it("pays only the final salary when nothing else applies", () => {
    const result = computeFnf(input(), DEFAULT_FNF_POLICY, DEFAULT_PAYROLL_POLICY);
    expect(result.netPaise).toBe(rupees(30_000));
    expect(result.lines).toHaveLength(1);
  });

  it("encashes unused earned leave at the daily rate", () => {
    const result = computeFnf(
      input({ leaveBalances: [{ leaveTypeCode: "EL", days: 10 }] }),
      DEFAULT_FNF_POLICY,
      DEFAULT_PAYROLL_POLICY,
    );
    // 30,000 ÷ 26 = 1,153.85 → 115,385 paise/day × 10
    expect(line(result, "LEAVE_ENCASHMENT")?.amountPaise).toBe(1_153_850);
  });

  it("ignores leave types that are not encashable", () => {
    const result = computeFnf(
      input({ leaveBalances: [{ leaveTypeCode: "CL", days: 10 }] }),
      DEFAULT_FNF_POLICY,
      DEFAULT_PAYROLL_POLICY,
    );
    expect(line(result, "LEAVE_ENCASHMENT")).toBeUndefined();
  });

  it("caps encashment at the configured maximum", () => {
    const policy = fnfPolicyWith((p) => {
      p.leaveEncashment.maxDays = 5;
    });
    const result = computeFnf(
      input({ leaveBalances: [{ leaveTypeCode: "EL", days: 40 }] }),
      policy,
      DEFAULT_PAYROLL_POLICY,
    );
    expect(line(result, "LEAVE_ENCASHMENT")?.amountPaise).toBe(115_385 * 5);
  });

  it("pays gratuity after the qualifying service period", () => {
    const policy = fnfPolicyWith((p) => {
      p.gratuity.enabled = true;
    });
    const result = computeFnf(input(), policy, DEFAULT_PAYROLL_POLICY);
    // 6 completed years × 15 days × (30,000 ÷ 26)
    expect(line(result, "GRATUITY")?.amountPaise).toBe(115_385 * 15 * 6);
  });

  it("refuses gratuity below the minimum service and says why", () => {
    const policy = fnfPolicyWith((p) => {
      p.gratuity.enabled = true;
    });
    const result = computeFnf(
      input({ employee: { id: "e", name: "New joiner", joinedOn: "2024-06-01" } }),
      policy,
      DEFAULT_PAYROLL_POLICY,
    );
    expect(line(result, "GRATUITY")).toBeUndefined();
    expect(result.warnings.some((w) => w.includes("not payable"))).toBe(true);
  });

  it("recovers pay for unserved notice", () => {
    const result = computeFnf(
      input({ noticeDaysRequired: 30, noticeDaysServed: 10 }),
      DEFAULT_FNF_POLICY,
      DEFAULT_PAYROLL_POLICY,
    );
    // 20 unserved days × (30,000 ÷ 30)
    expect(line(result, "NOTICE_RECOVERY")?.amountPaise).toBe(rupees(20_000));
    expect(result.netPaise).toBe(rupees(10_000));
  });

  it("recovers outstanding advances and unreturned assets", () => {
    const result = computeFnf(
      input({ advanceOutstandingPaise: rupees(5_000), assetRecoveryPaise: rupees(2_000) }),
      DEFAULT_FNF_POLICY,
      DEFAULT_PAYROLL_POLICY,
    );
    expect(result.deductionsPaise).toBe(rupees(7_000));
    expect(result.netPaise).toBe(rupees(23_000));
  });

  it("warns when the employee ends up owing the organisation", () => {
    const result = computeFnf(
      input({ finalSalaryPaise: rupees(5_000), advanceOutstandingPaise: rupees(20_000) }),
      DEFAULT_FNF_POLICY,
      DEFAULT_PAYROLL_POLICY,
    );
    expect(result.netPaise).toBeLessThan(0);
    expect(result.warnings.some((w) => w.includes("owes the organisation"))).toBe(true);
  });

  it("counts service years across leap years", () => {
    expect(yearsOfService("2020-01-01", "2024-12-31")).toBeCloseTo(5, 1);
  });
});

describe("payroll simulator", () => {
  it("runs the spec example end to end", () => {
    // ₹50,000 · 25 days present · 3 lates · 1 half day · 4 h overtime · ₹5,000 advance
    const { result } = simulatePayroll(
      {
        ctcMonthlyPaise: rupees(50_000),
        year: 2026,
        month: 4,
        presentDays: 25,
        halfDays: 1,
        lateCount: 3,
        overtimeMinutes: 240,
        advancePaise: rupees(5_000),
      },
      DEFAULT_PAYROLL_POLICY,
    );
    expect(result.days.presentDays).toBe(25.5);
    expect(result.days.lateCount).toBe(3);
    expect(result.advanceRecoveredPaise).toBe(rupees(5_000));
    expect(result.trace.length).toBeGreaterThan(5);
    expect(result.netPaise).toBeGreaterThan(0);
  });

  it("uses the same engine as production payroll", () => {
    const { result } = simulatePayroll(
      { ctcMonthlyPaise: rupees(30_000), year: 2026, month: 4, presentDays: 26 },
      DEFAULT_PAYROLL_POLICY,
    );
    // April 2026 has 4 Sundays; 26 present + 4 week offs = a full month.
    expect(result.netPaise).toBe(rupees(30_000));
  });

  it("reflects a training percentage", () => {
    const { result } = simulatePayroll(
      {
        ctcMonthlyPaise: rupees(30_000),
        year: 2026,
        month: 4,
        presentDays: 26,
        training: { mode: "PERCENT", percent: 70 },
      },
      DEFAULT_PAYROLL_POLICY,
    );
    expect(result.netPaise).toBe(rupees(21_000));
  });

  it("reports days that do not fit the month", () => {
    const { unallocatedDays } = simulatePayroll(
      { ctcMonthlyPaise: rupees(30_000), year: 2026, month: 4, presentDays: 40 },
      DEFAULT_PAYROLL_POLICY,
    );
    expect(unallocatedDays).toBeGreaterThan(0);
  });

  it("rejects an impossible month", () => {
    expect(() =>
      simulatePayroll(
        { ctcMonthlyPaise: rupees(1), year: 2026, month: 13, presentDays: 1 },
        DEFAULT_PAYROLL_POLICY,
      ),
    ).toThrow();
  });
});
