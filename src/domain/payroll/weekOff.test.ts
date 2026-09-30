import { describe, expect, it } from "vitest";

import { addDays } from "../date";
import { calculatePayroll } from "./engine";
import { DEFAULT_PAYROLL_POLICY, safeParsePayrollPolicy } from "./policy";
import type { DayLedgerEntry, PayrollInput, PayrollPolicy } from "./types";

/**
 * "Week off kitna milega 1 month me, paid hoga ki unpaid, aur agar utna week
 * off koi nahi liya to … jitna din nahi aaya utna salary jodna."
 *
 * Two halves. The quota and the paid flag are new; paying for the ones that
 * were not taken is the part that moves money, so it ships **off** and every
 * test below has to switch it on.
 */

const PERIOD = { year: 2026, month: 4, start: "2026-04-01", end: "2026-04-30" } as const;
const CALENDAR = {
  totalDays: 30,
  workingDays: 26,
  weekOffDays: 4,
  holidayDays: 0,
  paidHolidayDays: 0,
};
const rupees = (n: number) => n * 100;

function ledger(spec: Partial<Record<DayLedgerEntry["status"], number>>): DayLedgerEntry[] {
  const out: DayLedgerEntry[] = [];
  let cursor: string = PERIOD.start;
  for (const [status, count] of Object.entries(spec)) {
    for (let i = 0; i < (count ?? 0); i++) {
      out.push({
        date: cursor,
        status: status as DayLedgerEntry["status"],
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        overtimeMinutes: 0,
        isLate: false,
      });
      cursor = addDays(cursor, 1);
    }
  }
  return out;
}

function input(spec: Partial<Record<DayLedgerEntry["status"], number>>): PayrollInput {
  return {
    employee: { id: "emp_1", code: "E001", name: "Test Employee", joinedOn: "2024-01-01" },
    period: { ...PERIOD },
    ctcMonthlyPaise: rupees(30_000),
    segments: [],
    calendar: { ...CALENDAR },
    ledger: ledger(spec),
    advances: [],
    adjustments: [],
  };
}

function policyWith(patch: (p: PayrollPolicy) => void): PayrollPolicy {
  const copy = structuredClone(DEFAULT_PAYROLL_POLICY) as PayrollPolicy;
  patch(copy);
  return copy;
}

const unusedLine = (result: ReturnType<typeof calculatePayroll>) =>
  result.earnings.find((e) => e.code === "WEEK_OFF_UNUSED") ?? null;

describe("the shipped default changes nobody's pay", () => {
  it("is off, with no quota", () => {
    expect(DEFAULT_PAYROLL_POLICY.weekOff).toEqual({
      quotaPerMonth: null,
      paid: true,
      payUnused: { enabled: false, rate: { type: "NORMAL_DAY" } },
    });
  });

  it("credits nothing even when rest days were worked", () => {
    const result = calculatePayroll(
      input({ FULL_DAY: 26, EXTRA_DAY: 4 }),
      DEFAULT_PAYROLL_POLICY,
    );
    expect(unusedLine(result)).toBeNull();
  });
});

describe("paying for rest days that were not taken", () => {
  const on = (patch: (p: PayrollPolicy) => void = () => {}) =>
    policyWith((p) => {
      p.weekOff = {
        quotaPerMonth: 4,
        paid: true,
        payUnused: { enabled: true, rate: { type: "NORMAL_DAY" } },
      };
      patch(p);
    });

  it("pays a day's salary for each rest day worked instead of taken", () => {
    // 4 Sundays owed, all four worked: 30,000 ÷ 30 calendar days = 1,000/day.
    const result = calculatePayroll(input({ FULL_DAY: 26, EXTRA_DAY: 4 }), on());
    expect(unusedLine(result)?.amountPaise).toBe(rupees(4_000));
  });

  it("counts only the shortfall, not every rest day worked", () => {
    // Five rest days available, four owed, one worked — they still got four.
    const result = calculatePayroll(input({ FULL_DAY: 25, WEEK_OFF: 4, EXTRA_DAY: 1 }), on());
    expect(unusedLine(result)).toBeNull();
  });

  it("pays only two when two of four were taken", () => {
    const result = calculatePayroll(input({ FULL_DAY: 24, WEEK_OFF: 2, EXTRA_DAY: 2 }), on());
    expect(unusedLine(result)?.amountPaise).toBe(rupees(2_000));
  });

  it("never pays for a rest day nobody worked", () => {
    /**
     * The failure mode that would turn a generous rule into a wrong payslip: a
     * month whose calendar simply gave fewer rest days than the quota promised.
     * Nobody worked extra, so nothing is owed in cash — the shortfall is the
     * roster's problem, not the payslip's.
     */
    const result = calculatePayroll(input({ FULL_DAY: 28, WEEK_OFF: 2 }), on());
    expect(unusedLine(result)).toBeNull();
  });

  it("stays silent when rest days are unpaid — you cannot be owed cash for nothing", () => {
    const result = calculatePayroll(
      input({ FULL_DAY: 26, EXTRA_DAY: 4 }),
      on((p) => {
        p.weekOff.paid = false;
      }),
    );
    expect(unusedLine(result)).toBeNull();
  });

  it("stays silent with no quota, because there is nothing to fall short of", () => {
    const result = calculatePayroll(
      input({ FULL_DAY: 26, EXTRA_DAY: 4 }),
      on((p) => {
        p.weekOff.quotaPerMonth = null;
      }),
    );
    expect(unusedLine(result)).toBeNull();
  });
});

describe("the rate the administrator chooses", () => {
  const withRate = (rate: PayrollPolicy["weekOff"]["payUnused"]["rate"]) =>
    policyWith((p) => {
      p.weekOff = { quotaPerMonth: 4, paid: true, payUnused: { enabled: true, rate } };
    });

  it("a multiplier pays that many times a day", () => {
    const result = calculatePayroll(
      input({ FULL_DAY: 26, EXTRA_DAY: 4 }),
      withRate({ type: "MULTIPLIER", value: 2 }),
    );
    expect(unusedLine(result)?.amountPaise).toBe(rupees(8_000));
  });

  it("the overtime rate values a whole standard day at the hourly rate", () => {
    // 1,000/day ÷ 8 h = 125/h, × 1.5 × 8 h = 1,500 a day, × 4 days.
    const policy = withRate({ type: "OVERTIME_RATE" });
    policy.overtime.rate = { type: "MULTIPLIER", value: 1.5 };
    const result = calculatePayroll(input({ FULL_DAY: 26, EXTRA_DAY: 4 }), policy);
    expect(unusedLine(result)?.amountPaise).toBe(rupees(6_000));
  });

  it("a flat hourly rate is paid for a standard day, not for one hour", () => {
    const policy = withRate({ type: "OVERTIME_RATE" });
    policy.overtime.rate = { type: "FLAT_PER_HOUR", amountPaise: rupees(200) };
    const result = calculatePayroll(input({ FULL_DAY: 26, EXTRA_DAY: 4 }), policy);
    // 200/h × 8 h = 1,600 a day, × 4.
    expect(unusedLine(result)?.amountPaise).toBe(rupees(6_400));
  });

  it("does not need the overtime stage switched on to use its rate", () => {
    // The rate is a way of pricing a day, not a request to run the overtime
    // stage — which has no minutes to work with here anyway.
    const policy = withRate({ type: "OVERTIME_RATE" });
    expect(policy.overtime.enabled).toBe(false);
    const result = calculatePayroll(input({ FULL_DAY: 26, EXTRA_DAY: 4 }), policy);
    expect(unusedLine(result)?.amountPaise).toBeGreaterThan(0);
  });
});

/**
 * The one that would have taken a live organisation's salary structure away.
 *
 * `getPayrollPolicy` refuses a payload that will not parse and falls back to
 * `DEFAULT_PAYROLL_POLICY` — deliberately, so a malformed policy cannot quietly
 * pay the wrong amount. Every policy stored on this instance was written before
 * `weekOff` existed. A required key would therefore have failed all of them and
 * reverted BASIC/HRA/allowances to the shipped defaults, mid-payroll-month, on
 * deploy.
 */
describe("a policy stored before this key existed still parses", () => {
  const STORED_BEFORE = {
    version: 1,
    cycle: { type: "MONTHLY", startDay: 1 },
    payableDaysBasis: "CALENDAR_DAYS",
    percentBase: "CTC",
    components: [
      {
        code: "BASIC",
        name: "Basic Salary",
        kind: "EARNING",
        calc: { type: "PERCENT_OF_CTC", percent: 100 },
        prorated: true,
        taxable: true,
        showOnSlip: true,
        sortOrder: 1,
      },
      {
        code: "HRA",
        name: "House Rent Allowance",
        kind: "EARNING",
        calc: { type: "PERCENT_OF_CTC", percent: 0 },
        prorated: true,
        taxable: true,
        showOnSlip: true,
        sortOrder: 2,
      },
    ],
    attendance: {
      late: { type: "NONE" },
      earlyLeave: { type: "NONE" },
      absent: { type: "PER_DAY_RATE" },
      halfDayFactor: 0.5,
      unpaidLeaveUsesPerDayRate: true,
    },
    overtime: {
      enabled: false,
      rate: { type: "MULTIPLIER", value: 1 },
      hourlyBasis: "CTC_PER_HOUR",
      standardHoursPerDay: 8,
      maxPayableMinutesPerMonth: 0,
    },
    extraDay: { mode: "NORMAL_DAY" },
    leave: {
      paidLeaveIsPayable: true,
      unpaidLeaveDeducted: true,
      weekOffPayable: true,
      holidayPayable: true,
      sandwichUnpaid: false,
    },
    advance: { defaultMode: { mode: "FULL_NEXT" }, minNetPayPaise: 0 },
    training: { prorateAcrossTransition: true, defaultMode: "PERCENT", defaultPercent: 100 },
    statutory: {
      providentFund: {
        enabled: false,
        employeePercent: 12,
        wageCeilingPaise: 1_500_000,
        componentCode: "BASIC",
      },
      esi: { enabled: false, employeePercent: 0.75, wageCeilingPaise: 2_100_000 },
      professionalTax: { enabled: false, slabs: [] },
      incomeTax: { enabled: false, monthlyFlatPaise: 0 },
    },
    rounding: { mode: "NEAREST", to: 100 },
    stages: [
      "PRORATE_EARNINGS",
      "LATE_DEDUCTION",
      "EARLY_LEAVE_DEDUCTION",
      "UNPAID_LEAVE_DEDUCTION",
      "EXTRA_DAY_CREDIT",
      "OVERTIME_CREDIT",
      "ADJUSTMENTS",
      "STATUTORY_DEDUCTIONS",
      "ADVANCE_RECOVERY",
      "ROUNDING",
    ],
  };

  it("parses, rather than dropping the organisation onto the defaults", () => {
    const parsed = safeParsePayrollPolicy(STORED_BEFORE);
    expect(parsed.success).toBe(true);
  });

  it("keeps the components it was storing", () => {
    const parsed = safeParsePayrollPolicy(STORED_BEFORE);
    expect(parsed.success && parsed.data.components.map((c) => c.code)).toEqual(["BASIC", "HRA"]);
  });

  it("fills the missing block with the off-by-default value", () => {
    const parsed = safeParsePayrollPolicy(STORED_BEFORE);
    expect(parsed.success && parsed.data.weekOff).toEqual({
      quotaPerMonth: null,
      paid: true,
      payUnused: { enabled: false, rate: { type: "NORMAL_DAY" } },
    });
  });

  it("and that policy pays exactly what it did before", () => {
    const parsed = safeParsePayrollPolicy(STORED_BEFORE);
    if (!parsed.success) throw new Error("fixture no longer parses");
    const before = calculatePayroll(input({ FULL_DAY: 26, EXTRA_DAY: 4 }), parsed.data);
    expect(unusedLine(before)).toBeNull();
  });
});
