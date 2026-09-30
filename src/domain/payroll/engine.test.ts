import { describe, expect, it } from "vitest";
import { addDays } from "../date";
import { calculatePayroll } from "./engine";
import { DEFAULT_PAYROLL_POLICY } from "./policy";
import type { DayLedgerEntry, PayrollInput, PayrollPolicy, SalaryComponent } from "./types";

// April 2026: 30 calendar days, 4 Sundays, 26 working days.
const PERIOD = { year: 2026, month: 4, start: "2026-04-01", end: "2026-04-30" } as const;
const CALENDAR = { totalDays: 30, workingDays: 26, weekOffDays: 4, holidayDays: 0, paidHolidayDays: 0 };

const RUPEE = 100;
const rupees = (n: number) => n * RUPEE;

type LedgerSpec = Partial<Record<DayLedgerEntry["status"], number>>;

/** Builds a ledger with the requested count of each status, on sequential dates. */
function makeLedger(spec: LedgerSpec, extras: Partial<DayLedgerEntry>[] = []): DayLedgerEntry[] {
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
  extras.forEach((patch, i) => {
    const target = out[i];
    if (target) Object.assign(target, patch);
  });
  return out;
}

function makeInput(overrides: Partial<PayrollInput> = {}): PayrollInput {
  return {
    employee: { id: "emp_1", code: "E001", name: "Test Employee", joinedOn: "2024-01-01" },
    period: { ...PERIOD },
    ctcMonthlyPaise: rupees(30_000),
    segments: [],
    calendar: { ...CALENDAR },
    ledger: makeLedger({ FULL_DAY: 26, WEEK_OFF: 4 }),
    advances: [],
    adjustments: [],
    ...overrides,
  };
}

function policyWith(patch: (p: PayrollPolicy) => void): PayrollPolicy {
  const copy = structuredClone(DEFAULT_PAYROLL_POLICY) as PayrollPolicy;
  patch(copy);
  return copy;
}

// ------------------------------------------------------------------ baseline

describe("payroll — baseline", () => {
  it("pays the full CTC for a complete month", () => {
    const result = calculatePayroll(makeInput(), DEFAULT_PAYROLL_POLICY);
    expect(result.days.payableDays).toBe(30);
    expect(result.days.basisDays).toBe(30);
    expect(result.grossPaise).toBe(rupees(30_000));
    expect(result.netPaise).toBe(rupees(30_000));
  });

  it("is deterministic — the same input yields an identical result", () => {
    const input = makeInput();
    const a = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    const b = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(a).toEqual(b);
  });

  it("gives every amount a trace line", () => {
    const result = calculatePayroll(makeInput(), DEFAULT_PAYROLL_POLICY);
    const traced = new Set(result.trace.map((t) => t.label));
    for (const earning of result.earnings) {
      expect(traced.has(earning.label)).toBe(true);
    }
    expect(result.trace.some((t) => t.stage === "RESULT")).toBe(true);
  });

  // Spec §45 example 1.
  it("handles 24 present + 1 paid leave + 1 unpaid leave", () => {
    const input = makeInput({
      ledger: makeLedger({ FULL_DAY: 24, PAID_LEAVE: 1, UNPAID_LEAVE: 1, WEEK_OFF: 4 }),
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    // 24 present + 1 paid leave + 4 week off = 29 of 30 days.
    expect(result.days.payableDays).toBe(29);
    expect(result.netPaise).toBe(rupees(29_000));
  });

  it("treats a half day as half a payable day", () => {
    const input = makeInput({ ledger: makeLedger({ FULL_DAY: 25, HALF_DAY: 1, WEEK_OFF: 4 }) });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.days.payableDays).toBe(29.5);
    expect(result.netPaise).toBe(rupees(29_500));
  });

  it("does not deduct twice for an absence", () => {
    const input = makeInput({ ledger: makeLedger({ FULL_DAY: 25, ABSENT: 1, WEEK_OFF: 4 }) });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    // Exactly one day lost, via payable days — no separate absence deduction line.
    expect(result.netPaise).toBe(rupees(29_000));
    expect(result.deductions.find((d) => d.code === "ABSENT_PENALTY")).toBeUndefined();
  });
});

// ------------------------------------------------------------------ late / early

describe("payroll — late and early departure", () => {
  const lateLedger = makeLedger({ FULL_DAY: 26, WEEK_OFF: 4 }, [
    { isLate: true, lateMinutes: 20 },
    { isLate: true, lateMinutes: 20 },
    { isLate: true, lateMinutes: 20 },
  ]);

  it("PER_OCCURRENCE charges only beyond the free allowance", () => {
    const policy = policyWith((p) => {
      p.attendance.late = { type: "PER_OCCURRENCE", freeCount: 2, amountPaise: rupees(500) };
    });
    const result = calculatePayroll(makeInput({ ledger: lateLedger }), policy);
    expect(result.days.lateCount).toBe(3);
    expect(result.deductions.find((d) => d.code === "LATE")?.amountPaise).toBe(rupees(500));
    expect(result.netPaise).toBe(rupees(29_500));
  });

  it("HALF_DAY_PER_N converts every N lates into half a day", () => {
    const policy = policyWith((p) => {
      p.attendance.late = { type: "HALF_DAY_PER_N", n: 3, freeCount: 0 };
    });
    const result = calculatePayroll(makeInput({ ledger: lateLedger }), policy);
    // per-day rate 1,000 → half day = 500
    expect(result.deductions.find((d) => d.code === "LATE")?.amountPaise).toBe(rupees(500));
  });

  it("PRORATA_MINUTES charges per late minute beyond the free minutes", () => {
    const policy = policyWith((p) => {
      p.attendance.late = { type: "PRORATA_MINUTES", freeMinutes: 0 };
    });
    const result = calculatePayroll(makeInput({ ledger: lateLedger }), policy);
    // per-day 100000 paise ÷ 480 min = 208 paise/min × 60 min
    expect(result.deductions.find((d) => d.code === "LATE")?.amountPaise).toBe(208 * 60);
  });

  it("NONE leaves late arrivals unpunished but still recorded", () => {
    const result = calculatePayroll(makeInput({ ledger: lateLedger }), DEFAULT_PAYROLL_POLICY);
    expect(result.days.lateCount).toBe(3);
    expect(result.deductions.find((d) => d.code === "LATE")).toBeUndefined();
  });

  it("deducts for early departure independently of lateness", () => {
    const ledger = makeLedger({ FULL_DAY: 26, WEEK_OFF: 4 }, [
      { earlyLeaveMinutes: 45 },
      { earlyLeaveMinutes: 45 },
    ]);
    const policy = policyWith((p) => {
      p.attendance.earlyLeave = { type: "PER_OCCURRENCE", freeCount: 1, amountPaise: rupees(200) };
    });
    const result = calculatePayroll(makeInput({ ledger }), policy);
    expect(result.deductions.find((d) => d.code === "EARLY_LEAVE")?.amountPaise).toBe(rupees(200));
  });
});

// ------------------------------------------------------------------ absence rules

describe("payroll — absence penalties beyond the natural loss", () => {
  const ledger = makeLedger({ FULL_DAY: 25, ABSENT: 1, WEEK_OFF: 4 });

  it("MULTIPLIER 2 costs one extra day on top of the day already lost", () => {
    const policy = policyWith((p) => {
      p.attendance.absent = { type: "MULTIPLIER", multiplier: 2 };
    });
    const result = calculatePayroll(makeInput({ ledger }), policy);
    expect(result.deductions.find((d) => d.code === "ABSENT_PENALTY")?.amountPaise).toBe(rupees(1_000));
    expect(result.netPaise).toBe(rupees(28_000));
  });

  it("FIXED_PER_DAY replaces the natural per-day loss", () => {
    const policy = policyWith((p) => {
      p.attendance.absent = { type: "FIXED_PER_DAY", amountPaise: rupees(1_500) };
    });
    const result = calculatePayroll(makeInput({ ledger }), policy);
    // Natural loss 1,000 + penalty 500 = 1,500 total for the absent day.
    expect(result.deductions.find((d) => d.code === "ABSENT_PENALTY")?.amountPaise).toBe(rupees(500));
    expect(result.netPaise).toBe(rupees(28_500));
  });
});

// ------------------------------------------------------------------ extra day

describe("payroll — working on a week off", () => {
  const ledger = makeLedger({ FULL_DAY: 26, WEEK_OFF: 3, EXTRA_DAY: 1 });

  it("keeps the rest day paid and adds nothing under NORMAL_DAY", () => {
    const result = calculatePayroll(makeInput({ ledger }), DEFAULT_PAYROLL_POLICY);
    expect(result.days.extraDays).toBe(1);
    expect(result.days.payableDays).toBe(30);
    expect(result.netPaise).toBe(rupees(30_000));
  });

  it("pays one extra day at MULTIPLIER 1 (spec option A)", () => {
    const policy = policyWith((p) => {
      p.extraDay = { mode: "MULTIPLIER", multiplier: 1 };
    });
    const result = calculatePayroll(makeInput({ ledger }), policy);
    expect(result.netPaise).toBe(rupees(31_000));
  });

  it("pays double at MULTIPLIER 2 (spec option B)", () => {
    const policy = policyWith((p) => {
      p.extraDay = { mode: "MULTIPLIER", multiplier: 2 };
    });
    const result = calculatePayroll(makeInput({ ledger }), policy);
    expect(result.netPaise).toBe(rupees(32_000));
  });

  it("credits compensatory off instead of cash (spec option D)", () => {
    const policy = policyWith((p) => {
      p.extraDay = { mode: "COMP_OFF", leaveTypeCode: "COMP_OFF", daysPerExtraDay: 1 };
    });
    const result = calculatePayroll(makeInput({ ledger }), policy);
    expect(result.netPaise).toBe(rupees(30_000));
    expect(result.compOffCredits).toEqual([{ leaveTypeCode: "COMP_OFF", days: 1 }]);
  });

  it("does not lose the rest day's pay when the employee works it", () => {
    const worked = calculatePayroll(makeInput({ ledger }), DEFAULT_PAYROLL_POLICY);
    const rested = calculatePayroll(makeInput(), DEFAULT_PAYROLL_POLICY);
    expect(worked.netPaise).toBeGreaterThanOrEqual(rested.netPaise);
  });
});

// ------------------------------------------------------------------ overtime

describe("payroll — overtime", () => {
  it("pays a multiplier of the hourly rate", () => {
    const ledger = makeLedger({ FULL_DAY: 26, WEEK_OFF: 4 }, [{ overtimeMinutes: 240 }]);
    const policy = policyWith((p) => {
      p.overtime.enabled = true;
      p.overtime.rate = { type: "MULTIPLIER", value: 1.5 };
    });
    const result = calculatePayroll(makeInput({ ledger }), policy);
    // per-day 1,000 ÷ 8 h = 125/h → 4 h × 125 × 1.5 = 750
    expect(result.earnings.find((e) => e.code === "OVERTIME")?.amountPaise).toBe(rupees(750));
  });

  it("honours a flat hourly rate and the monthly cap", () => {
    const ledger = makeLedger({ FULL_DAY: 26, WEEK_OFF: 4 }, [{ overtimeMinutes: 600 }]);
    const policy = policyWith((p) => {
      p.overtime.enabled = true;
      p.overtime.rate = { type: "FLAT_PER_HOUR", amountPaise: rupees(200) };
      p.overtime.maxPayableMinutesPerMonth = 300;
    });
    const result = calculatePayroll(makeInput({ ledger }), policy);
    expect(result.earnings.find((e) => e.code === "OVERTIME")?.amountPaise).toBe(rupees(1_000));
  });

  it("pays nothing when overtime is disabled", () => {
    const ledger = makeLedger({ FULL_DAY: 26, WEEK_OFF: 4 }, [{ overtimeMinutes: 240 }]);
    const result = calculatePayroll(makeInput({ ledger }), DEFAULT_PAYROLL_POLICY);
    expect(result.earnings.find((e) => e.code === "OVERTIME")).toBeUndefined();
  });
});

// ------------------------------------------------------------------ advances

describe("payroll — salary advances", () => {
  // Spec §45 example 7: ₹40,000 salary, ₹8,000 advance, full recovery → ₹32,000.
  it("recovers the whole outstanding balance under FULL_NEXT", () => {
    const input = makeInput({
      ctcMonthlyPaise: rupees(40_000),
      advances: [
        {
          id: "adv_1",
          outstandingPaise: rupees(8_000),
          originalAmountPaise: rupees(8_000),
          installmentsPaid: 0,
          recovery: { mode: "FULL_NEXT" },
        },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.advanceRecoveredPaise).toBe(rupees(8_000));
    expect(result.netPaise).toBe(rupees(32_000));
  });

  it("recovers one instalment at a time", () => {
    const input = makeInput({
      advances: [
        {
          id: "adv_1",
          outstandingPaise: rupees(10_000),
          originalAmountPaise: rupees(10_000),
          installmentsPaid: 0,
          recovery: { mode: "INSTALLMENTS", installments: 4 },
        },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.advanceRecoveredPaise).toBe(rupees(2_500));
    expect(result.netPaise).toBe(rupees(27_500));
  });

  it("recovers a percentage of net pay", () => {
    const input = makeInput({
      advances: [
        {
          id: "adv_1",
          outstandingPaise: rupees(10_000),
          originalAmountPaise: rupees(10_000),
          installmentsPaid: 0,
          recovery: { mode: "PERCENT_OF_NET", percent: 10 },
        },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.advanceRecoveredPaise).toBe(rupees(3_000));
  });

  it("never pushes net pay below the configured floor", () => {
    const policy = policyWith((p) => {
      p.advance.minNetPayPaise = rupees(28_000);
    });
    const input = makeInput({
      advances: [
        {
          id: "adv_1",
          outstandingPaise: rupees(10_000),
          originalAmountPaise: rupees(10_000),
          installmentsPaid: 0,
          recovery: { mode: "FULL_NEXT" },
        },
      ],
    });
    const result = calculatePayroll(input, policy);
    expect(result.advanceRecoveredPaise).toBe(rupees(2_000));
    expect(result.netPaise).toBe(rupees(28_000));
    expect(result.warnings.some((w) => w.includes("carries forward"))).toBe(true);
  });

  it("spreads recovery across multiple advances in order", () => {
    const input = makeInput({
      advances: [
        { id: "a", outstandingPaise: rupees(1_000), originalAmountPaise: rupees(1_000), installmentsPaid: 0, recovery: { mode: "FULL_NEXT" } },
        { id: "b", outstandingPaise: rupees(2_000), originalAmountPaise: rupees(2_000), installmentsPaid: 0, recovery: { mode: "FULL_NEXT" } },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.advanceRecoveries).toEqual([
      { advanceId: "a", amountPaise: rupees(1_000) },
      { advanceId: "b", amountPaise: rupees(2_000) },
    ]);
    expect(result.netPaise).toBe(rupees(27_000));
  });
});

// ------------------------------------------------------------------ training

describe("payroll — training and probation salary", () => {
  // Spec §45 example 6: ₹40,000 normal, full month of training at 50 % → ₹20,000.
  it("pays a percentage of normal salary during training", () => {
    const input = makeInput({
      ctcMonthlyPaise: rupees(40_000),
      segments: [
        {
          from: "2026-04-01",
          to: "2026-04-30",
          state: "TRAINING",
          ctcMonthlyPaise: rupees(40_000),
          training: { mode: "PERCENT", percent: 50 },
        },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.ctcMonthlyPaise).toBe(rupees(20_000));
    expect(result.netPaise).toBe(rupees(20_000));
  });

  it("pays a fixed stipend when configured", () => {
    const input = makeInput({
      segments: [
        {
          from: "2026-04-01",
          to: "2026-04-30",
          state: "TRAINING",
          ctcMonthlyPaise: rupees(40_000),
          training: { mode: "FIXED", fixedAmountPaise: rupees(12_000) },
        },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.netPaise).toBe(rupees(12_000));
  });

  it("pays nothing for unpaid training", () => {
    const input = makeInput({
      segments: [
        {
          from: "2026-04-01",
          to: "2026-04-30",
          state: "TRAINING",
          ctcMonthlyPaise: rupees(40_000),
          training: { mode: "UNPAID" },
        },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.netPaise).toBe(0);
  });

  it("blends both rates when training ends mid-month", () => {
    const input = makeInput({
      segments: [
        {
          from: "2026-04-01",
          to: "2026-04-15",
          state: "TRAINING",
          ctcMonthlyPaise: rupees(40_000),
          training: { mode: "PERCENT", percent: 50 },
        },
        { from: "2026-04-16", to: "2026-04-30", state: "REGULAR", ctcMonthlyPaise: rupees(40_000) },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    // 15 days at ₹20,000 + 15 days at ₹40,000 → ₹30,000 blended
    expect(result.ctcMonthlyPaise).toBe(rupees(30_000));
    expect(result.netPaise).toBe(rupees(30_000));
  });
});

// ------------------------------------------------------------------ structure

describe("payroll — salary distribution", () => {
  const distributed: SalaryComponent[] = [
    { code: "BASIC", name: "Basic", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 50 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 1 },
    { code: "HRA", name: "HRA", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 20 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 2 },
    { code: "SPECIAL", name: "Special", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 20 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 3 },
    { code: "OTHER", name: "Other", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 10 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 4 },
  ];

  // Spec §21 worked example.
  it("splits ₹50,000 into 50/20/20/10", () => {
    const input = makeInput({ ctcMonthlyPaise: rupees(50_000), componentOverrides: distributed });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    const byCode = Object.fromEntries(result.earnings.map((e) => [e.code, e.amountPaise]));
    expect(byCode.BASIC).toBe(rupees(25_000));
    expect(byCode.HRA).toBe(rupees(10_000));
    expect(byCode.SPECIAL).toBe(rupees(10_000));
    expect(byCode.OTHER).toBe(rupees(5_000));
    expect(result.grossPaise).toBe(rupees(50_000));
  });

  it("prorates every component together on partial attendance", () => {
    const input = makeInput({
      ctcMonthlyPaise: rupees(50_000),
      componentOverrides: distributed,
      ledger: makeLedger({ FULL_DAY: 23, ABSENT: 3, WEEK_OFF: 4 }),
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    // 27 of 30 days payable
    expect(result.grossPaise).toBe(rupees(45_000));
  });

  it("supports mixed fixed and percentage components", () => {
    const mixed: SalaryComponent[] = [
      { code: "CONVEYANCE", name: "Conveyance", kind: "EARNING", calc: { type: "FIXED", amountPaise: rupees(5_000) }, prorated: false, taxable: false, showOnSlip: true, sortOrder: 1 },
      { code: "BASIC", name: "Basic", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 60 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 2 },
      { code: "HRA", name: "HRA", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 40 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 3 },
    ];
    const policy = policyWith((p) => {
      p.percentBase = "CTC_MINUS_FIXED";
    });
    const input = makeInput({ ctcMonthlyPaise: rupees(50_000), componentOverrides: mixed });
    const result = calculatePayroll(input, policy);
    const byCode = Object.fromEntries(result.earnings.map((e) => [e.code, e.amountPaise]));
    expect(byCode.CONVEYANCE).toBe(rupees(5_000));
    expect(byCode.BASIC).toBe(rupees(27_000));
    expect(byCode.HRA).toBe(rupees(18_000));
    expect(result.grossPaise).toBe(rupees(50_000));
  });

  it("keeps a non-prorated component whole on partial attendance", () => {
    const mixed: SalaryComponent[] = [
      { code: "CONVEYANCE", name: "Conveyance", kind: "EARNING", calc: { type: "FIXED", amountPaise: rupees(5_000) }, prorated: false, taxable: false, showOnSlip: true, sortOrder: 1 },
      { code: "BASIC", name: "Basic", kind: "EARNING", calc: { type: "BALANCE" }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 2 },
    ];
    const input = makeInput({
      ctcMonthlyPaise: rupees(30_000),
      componentOverrides: mixed,
      ledger: makeLedger({ FULL_DAY: 23, ABSENT: 3, WEEK_OFF: 4 }),
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    const byCode = Object.fromEntries(result.earnings.map((e) => [e.code, e.amountPaise]));
    expect(byCode.CONVEYANCE).toBe(rupees(5_000));
    // Balance = 25,000, prorated 27/30
    expect(byCode.BASIC).toBe(rupees(22_500));
  });
});

// ------------------------------------------------------------------ payable-day basis

describe("payroll — payable day basis", () => {
  it("FIXED_30 always divides by 30", () => {
    const policy = policyWith((p) => {
      p.payableDaysBasis = "FIXED_30";
    });
    const result = calculatePayroll(makeInput(), policy);
    expect(result.days.basisDays).toBe(30);
    expect(result.netPaise).toBe(rupees(30_000));
  });

  it("WORKING_DAYS excludes week offs from both sides of the ratio", () => {
    const policy = policyWith((p) => {
      p.payableDaysBasis = "WORKING_DAYS";
    });
    const input = makeInput({ ledger: makeLedger({ FULL_DAY: 25, ABSENT: 1, WEEK_OFF: 4 }) });
    const result = calculatePayroll(input, policy);
    expect(result.days.basisDays).toBe(26);
    expect(result.days.payableDays).toBe(25);
    // One working day of 26 lost
    expect(result.netPaise).toBe(rupees(28_846));
  });
});

// ------------------------------------------------------------------ week-off quota

/**
 * The quota reaches the engine three ways -- the person's own figure, their
 * designation's, then the payroll rule -- and the input builder collapses the
 * first two into `weekOffQuota`. What is pinned here is the seam: a quota on
 * the input beats the rule, and a null on the input asks the rule.
 */
describe("payroll — a personal week-off quota", () => {
  const unusedLine = (result: ReturnType<typeof calculatePayroll>) =>
    result.earnings.find((e) => e.code === "WEEK_OFF_UNUSED") ?? null;

  const paysUnused = policyWith((p) => {
    p.weekOff = {
      quotaPerMonth: 2,
      paid: true,
      payUnused: { enabled: true, rate: { type: "NORMAL_DAY" } },
    };
  });

  it("reaches WEEK_OFF_UNUSED ahead of the rule's own figure", () => {
    // Four Sundays owed by the person's own quota, all four worked. The rule
    // says two; the person's record says four; four is what is paid for --
    // 30,000 / 30 calendar days = 1,000 a day.
    const result = calculatePayroll(
      makeInput({ ledger: makeLedger({ FULL_DAY: 26, EXTRA_DAY: 4 }), weekOffQuota: 4 }),
      paysUnused,
    );
    expect(unusedLine(result)?.amountPaise).toBe(rupees(4_000));
    expect(result.trace.find((t) => t.stage === "EXTRA_DAY_CREDIT" && t.label === "Unused week offs")?.inputs)
      .toMatchObject({ quota: 4, worked: 4, unused: 4 });
  });

  it("null on the input asks the rule, exactly as undefined does", () => {
    const ledger = makeLedger({ FULL_DAY: 26, EXTRA_DAY: 4 });
    const fromNull = calculatePayroll(makeInput({ ledger, weekOffQuota: null }), paysUnused);
    const fromUndefined = calculatePayroll(makeInput({ ledger }), paysUnused);
    expect(unusedLine(fromNull)?.amountPaise).toBe(rupees(2_000));
    expect(unusedLine(fromUndefined)?.amountPaise).toBe(rupees(2_000));
  });

  it("a personal zero is a real quota, not an absent one", () => {
    // Nothing owed, so nothing is paid for -- the zero must not fall through
    // to the rule's two.
    const result = calculatePayroll(
      makeInput({ ledger: makeLedger({ FULL_DAY: 26, EXTRA_DAY: 4 }), weekOffQuota: 0 }),
      paysUnused,
    );
    expect(unusedLine(result)).toBeNull();
  });
});

// ------------------------------------------------------------------ adjustments, statutory, rounding

describe("payroll — adjustments, statutory and rounding", () => {
  it("applies bonuses and other deductions from adjustments", () => {
    const input = makeInput({
      adjustments: [
        { code: "BONUS", label: "Festival bonus", kind: "EARNING", amountPaise: rupees(2_000) },
        { code: "CANTEEN", label: "Canteen recovery", kind: "DEDUCTION", amountPaise: rupees(500) },
      ],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.netPaise).toBe(rupees(31_500));
  });

  it("deducts provident fund against the configured ceiling", () => {
    const policy = policyWith((p) => {
      p.statutory.providentFund = {
        enabled: true,
        employeePercent: 12,
        wageCeilingPaise: rupees(15_000),
        componentCode: "BASIC",
      };
    });
    const result = calculatePayroll(makeInput(), policy);
    // Basic is 30,000 but capped at the 15,000 ceiling → 12 % = 1,800
    expect(result.deductions.find((d) => d.code === "PF")?.amountPaise).toBe(rupees(1_800));
  });

  it("rounds the net to whole rupees", () => {
    const input = makeInput({
      adjustments: [{ code: "MISC", label: "Misc", kind: "EARNING", amountPaise: 149 }],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.netPaise % 100).toBe(0);
    expect(result.netPaise).toBe(rupees(30_001));
  });

  it("can round down instead", () => {
    const policy = policyWith((p) => {
      p.rounding = { mode: "DOWN", to: 100 };
    });
    const input = makeInput({
      adjustments: [{ code: "MISC", label: "Misc", kind: "EARNING", amountPaise: 199 }],
    });
    const result = calculatePayroll(input, policy);
    expect(result.netPaise).toBe(rupees(30_001));
  });

  it("warns when deductions exceed earnings", () => {
    const input = makeInput({
      adjustments: [{ code: "RECOVERY", label: "Recovery", kind: "DEDUCTION", amountPaise: rupees(40_000) }],
    });
    const result = calculatePayroll(input, DEFAULT_PAYROLL_POLICY);
    expect(result.netPaise).toBeLessThan(0);
    expect(result.warnings.some((w) => w.includes("negative"))).toBe(true);
  });
});

describe("the statutory wage base", () => {
  const withEsi = () =>
    policyWith((p) => {
      p.statutory.esi.enabled = true;
      p.statutory.esi.employeePercent = 0.75;
      // A ceiling just above the plain salary, so an inflated base crosses it.
      p.statutory.esi.wageCeilingPaise = rupees(31_000);
    });

  function esiOf(result: ReturnType<typeof calculatePayroll>) {
    return result.deductions.find((d) => d.code === "ESI")?.amountPaise ?? null;
  }

  it("does not grow because an expense was repaid", () => {
    // The bug: a reimbursement is not wages, and counting it either raises
    // somebody ESI because the company paid back their train fare, or pushes
    // them over the ceiling and stops their ESI altogether.
    const plain = calculatePayroll(makeInput(), withEsi());
    const withReimbursement = calculatePayroll(
      makeInput({
        adjustments: [
          {
            code: "REIMB",
            label: "Travel reimbursement",
            kind: "EARNING",
            amountPaise: rupees(4_000),
          },
        ],
      }),
      withEsi(),
    );

    expect(esiOf(plain)).not.toBeNull();
    expect(esiOf(withReimbursement)).toBe(esiOf(plain));
  });

  it("does not let a repayment cross the wage ceiling and remove ESI", () => {
    // The worse half of the same bug, and the reason this is not cosmetic:
    // 30,000 is under the ceiling, 34,000 is over it, and crossing it deletes
    // the deduction rather than raising it.
    const result = calculatePayroll(
      makeInput({
        adjustments: [
          { code: "REIMB", label: "Reimbursement", kind: "EARNING", amountPaise: rupees(4_000) },
        ],
      }),
      withEsi(),
    );
    expect(esiOf(result)).not.toBeNull();
  });

  it("still counts everything the salary structure pays", () => {
    // Excluding adjustments must not quietly exclude real salary components.
    const result = calculatePayroll(makeInput(), withEsi());
    const gross = result.earnings.reduce((sum, e) => sum + e.amountPaise, 0);
    expect(esiOf(result)).toBe(Math.round((gross * 0.75) / 100));
  });
});

describe("provident fund with no component to calculate from", () => {
  const policy = () =>
    policyWith((p) => {
      p.statutory.providentFund.enabled = true;
      p.statutory.providentFund.componentCode = "BASIC";
      // What deactivating BASIC on the salary structure screen leaves behind.
      p.components = p.components.filter((c) => c.code !== "BASIC");
      const first = p.components[0];
      if (first) first.calc = { type: "PERCENT_OF_CTC", percent: 100 };
    });

  it("deducts nothing rather than 12% of everything", () => {
    // The bug: a missing component fell back to the whole gross, so switching
    // BASIC off months later turned 12% of basic into 12% of the lot -- out of
    // somebody pay, with nothing said.
    const result = calculatePayroll(makeInput(), policy());
    expect(result.deductions.find((d) => d.code === "PF")).toBeUndefined();
  });

  it("says why, on the payslip", () => {
    const result = calculatePayroll(makeInput(), policy());
    expect(result.warnings.join(" ")).toContain("Provident fund was not deducted");
    expect(result.warnings.join(" ")).toContain("BASIC");
  });

  it("still deducts normally when the component is there", () => {
    const normal = policyWith((p) => {
      p.statutory.providentFund.enabled = true;
      p.statutory.providentFund.componentCode = "BASIC";
    });
    const result = calculatePayroll(makeInput(), normal);
    const pf = result.deductions.find((d) => d.code === "PF");
    // 12% of the wage ceiling, not of the whole basic: the shipped ceiling is
    // 15,000, and basic here is 30,000.
    const ceiling = normal.statutory.providentFund.wageCeilingPaise;
    expect(pf?.amountPaise).toBe(Math.round((ceiling * 12) / 100));
  });
});
