/**
 * Payroll policy — the whole rule set an organisation can configure, and the
 * inputs/outputs of a payroll calculation.
 *
 * The engine reads only this shape. Nothing about a specific organisation is
 * baked into code: changing behaviour means changing a stored policy document.
 */

import type { Money, RoundingConfig } from "../money";
import type { DateOnly } from "../date";
import type { AttendanceStatus } from "../attendance/policy";

// ------------------------------------------------------------------ components

export type ComponentKind = "EARNING" | "DEDUCTION";

export type ComponentCalc =
  | { type: "PERCENT_OF_CTC"; percent: number }
  | { type: "PERCENT_OF_COMPONENT"; of: string; percent: number }
  | { type: "FIXED"; amountPaise: Money }
  | { type: "BALANCE" };

export interface SalaryComponent {
  code: string;
  name: string;
  kind: ComponentKind;
  calc: ComponentCalc;
  /** Reduced by the payable-day ratio. Reimbursements are usually not. */
  prorated: boolean;
  /**
   * **Recorded, and read by nothing.**
   *
   * Income tax in this product is a flat monthly figure an administrator types
   * in, so there is no calculation for a component's taxability to feed. The
   * field is kept because it is the right shape for TDS when there is TDS; the
   * settings screen deliberately does not offer it as a switch, because a
   * switch that changes no figure is worse than no switch.
   */
  taxable: boolean;
  showOnSlip: boolean;
  sortOrder: number;
}

/** How percentages relate to the declared monthly CTC. */
export type PercentBase = "CTC" | "CTC_MINUS_FIXED";

// ------------------------------------------------------------------ deductions

export type LateDeductionRule =
  | { type: "NONE" }
  /** Flat amount for every late arrival beyond the free allowance. */
  | { type: "PER_OCCURRENCE"; freeCount: number; amountPaise: Money }
  /** Every N lates (after the free ones) cost half a day's pay. */
  | { type: "HALF_DAY_PER_N"; n: number; freeCount: number }
  /** Deduct pro-rata for the minutes lost. */
  | { type: "PRORATA_MINUTES"; freeMinutes: number };

export type EarlyLeaveRule =
  | { type: "NONE" }
  | { type: "PER_OCCURRENCE"; freeCount: number; amountPaise: Money }
  | { type: "HALF_DAY_PER_N"; n: number; freeCount: number }
  | { type: "PRORATA_MINUTES"; freeMinutes: number };

export type AbsentRule =
  | { type: "PER_DAY_RATE" }
  | { type: "FIXED_PER_DAY"; amountPaise: Money }
  | { type: "MULTIPLIER"; multiplier: number };

export interface AttendanceDeductionPolicy {
  late: LateDeductionRule;
  earlyLeave: EarlyLeaveRule;
  absent: AbsentRule;
  /** Fraction of a day credited for a half day. */
  halfDayFactor: number;
  /**
   * **Declared, and read by nothing.**
   *
   * Unpaid leave is handled by excluding those days from the payable days,
   * which *is* the per-day rate -- so this reads as a choice and has only ever
   * had one outcome. Deducting by the absent rule instead is a real alternative
   * and would be a change to how people are paid, so it is not being invented
   * quietly here. Nothing offers it; the AI is told not to propose it.
   */
  unpaidLeaveUsesPerDayRate: boolean;
}

// ------------------------------------------------------------------ credits

/**
 * Working on a week-off or holiday. The rest day itself stays paid in every mode
 * (it is counted in payable days); these options decide what is paid *on top*.
 *
 *   NORMAL_DAY   nothing extra — the day is simply treated as an ordinary paid day
 *   MULTIPLIER 1 one extra day's salary          (spec option A)
 *   MULTIPLIER 2 two extra days' salary          (spec option B)
 *   OVERTIME_RATE paid through the overtime stage (spec option C)
 *   COMP_OFF      no cash; credits a leave balance (spec option D)
 */
export type ExtraDayPolicy =
  | { mode: "NORMAL_DAY" }
  | { mode: "MULTIPLIER"; multiplier: number }
  | { mode: "OVERTIME_RATE" }
  | { mode: "COMP_OFF"; leaveTypeCode: string; daysPerExtraDay: number };

export type OvertimeRate =
  | { type: "MULTIPLIER"; value: number }
  | { type: "FLAT_PER_HOUR"; amountPaise: Money };

export interface OvertimePayPolicy {
  enabled: boolean;
  rate: OvertimeRate;
  /** Hourly rate basis when using MULTIPLIER. */
  hourlyBasis: "CTC_PER_HOUR" | "BASIC_PER_HOUR";
  /** Standard hours per day used to derive an hourly rate. */
  standardHoursPerDay: number;
  maxPayableMinutesPerMonth: number;
}

/**
 * How a week off is paid, and what happens when somebody does not take theirs.
 *
 * `weekOffPayable` in `LeavePayPolicy` already answers "is a rest day paid".
 * This answers two questions it cannot: **how many** rest days a month owes
 * somebody, and what is owed when they worked instead of taking them.
 *
 * The whole block is off by default and `payUnused.enabled` is false, because a
 * default that pays more reaches every existing organisation on deploy and
 * changes a salary nobody asked to change.
 */
export interface WeekOffPolicy {
  /**
   * Rest days a month owes, or null to mean "however many the pattern gives".
   *
   * Null rather than a number, because a Sunday-off organisation gets four or
   * five depending on the month and neither is the promise they made.
   */
  quotaPerMonth: number | null;
  /** Rest days within the quota are paid. */
  paid: boolean;
  /** Pay for rest days the person did not get to take. */
  payUnused: {
    enabled: boolean;
    rate: WeekOffUnusedRate;
  };
}

/**
 * What an untaken rest day is worth.
 *
 * `OVERTIME_RATE` values the day at the overtime hourly rate for a standard
 * day, which is what "overtime me jod do" means when the thing being added is a
 * whole day rather than a stretch of minutes.
 */
export type WeekOffUnusedRate =
  | { type: "NORMAL_DAY" }
  | { type: "MULTIPLIER"; value: number }
  | { type: "OVERTIME_RATE" };

export interface LeavePayPolicy {
  /** Paid leave days count towards payable days. */
  paidLeaveIsPayable: boolean;
  /** Unpaid leave days are deducted at the per-day rate. */
  unpaidLeaveDeducted: boolean;
  /** Week-offs and holidays are paid (standard for monthly salaries). */
  weekOffPayable: boolean;
  holidayPayable: boolean;
  /**
   * Sandwich rule: a week-off/holiday between two unpaid-leave days also becomes
   * unpaid.
   *
   * **Declared, and read by nothing.** `countDays` never looks at it, so an
   * organisation that switched it on was paying the sandwiched day anyway. It
   * is a real rule and a common one, and it is also a rule that takes money off
   * somebody -- so it gets implemented deliberately, with tests, rather than
   * wired up at the end of a long change. Until then nothing offers it and the
   * AI is told not to propose it.
   */
  sandwichUnpaid: boolean;
}

export type AdvanceRecoveryMode =
  | { mode: "FULL_NEXT" }
  | { mode: "INSTALLMENTS"; installments: number }
  | { mode: "FIXED_PER_MONTH"; amountPaise: Money }
  | { mode: "PERCENT_OF_NET"; percent: number }
  | { mode: "MANUAL" };

export interface AdvanceRecoveryPolicy {
  defaultMode: AdvanceRecoveryMode;
  /** Never let recovery push net pay below this floor. */
  minNetPayPaise: Money;
}

export interface TrainingPayPolicy {
  /** What happens when the plan ends mid-period. */
  prorateAcrossTransition: boolean;
  /** Default treatment when a training plan omits its own. */
  defaultMode: "PERCENT" | "FIXED" | "UNPAID";
  defaultPercent: number;
}

export interface StatutoryPolicy {
  providentFund: { enabled: boolean; employeePercent: number; wageCeilingPaise: Money; componentCode: string };
  esi: { enabled: boolean; employeePercent: number; wageCeilingPaise: Money };
  professionalTax: { enabled: boolean; slabs: { uptoPaise: Money; amountPaise: Money }[] };
  incomeTax: { enabled: boolean; monthlyFlatPaise: Money };
}

// ------------------------------------------------------------------ policy

export type PayableDaysBasis =
  /** Denominator = calendar days in the month (30 or 31). */
  | "CALENDAR_DAYS"
  /** Denominator = always 30. */
  | "FIXED_30"
  /** Denominator = working days only (week-offs and holidays excluded). */
  | "WORKING_DAYS"
  /** Denominator = working days + paid week-offs/holidays. */
  | "WORKING_DAYS_PLUS_PAID_OFF";

export type PipelineStage =
  | "PRORATE_EARNINGS"
  | "LATE_DEDUCTION"
  | "EARLY_LEAVE_DEDUCTION"
  | "UNPAID_LEAVE_DEDUCTION"
  | "EXTRA_DAY_CREDIT"
  | "OVERTIME_CREDIT"
  | "ADJUSTMENTS"
  | "STATUTORY_DEDUCTIONS"
  | "ADVANCE_RECOVERY"
  | "ROUNDING";

export const DEFAULT_STAGE_ORDER: PipelineStage[] = [
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
];

export interface PayrollPolicy {
  version: number;
  cycle: { type: "MONTHLY"; startDay: number };
  payableDaysBasis: PayableDaysBasis;
  percentBase: PercentBase;
  components: SalaryComponent[];
  attendance: AttendanceDeductionPolicy;
  overtime: OvertimePayPolicy;
  extraDay: ExtraDayPolicy;
  weekOff: WeekOffPolicy;
  leave: LeavePayPolicy;
  advance: AdvanceRecoveryPolicy;
  training: TrainingPayPolicy;
  statutory: StatutoryPolicy;
  rounding: RoundingConfig;
  stages: PipelineStage[];
}

// ------------------------------------------------------------------ inputs

export interface DayLedgerEntry {
  date: DateOnly;
  status: AttendanceStatus;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
}

export interface EmploymentSegment {
  from: DateOnly;
  to: DateOnly;
  /**
   * Only TRAINING changes what is paid (see `engine.ts`, where a training
   * segment can carry its own rate). The rest are carried so the trace line on
   * a payslip says what the person actually was that month rather than
   * flattening everybody to "regular".
   */
  state: "TRAINING" | "PROBATION" | "REGULAR" | "CONFIRMED" | "NOTICE_PERIOD";
  /** Effective monthly CTC during this segment. */
  ctcMonthlyPaise: Money;
  training?: {
    mode: "PERCENT" | "FIXED" | "UNPAID";
    percent?: number;
    fixedAmountPaise?: Money;
  };
}

export interface AdvanceInput {
  id: string;
  outstandingPaise: Money;
  recovery: AdvanceRecoveryMode;
  /** Installments already recovered, for INSTALLMENTS mode. */
  installmentsPaid: number;
  originalAmountPaise: Money;
}

export interface AdjustmentInput {
  code: string;
  label: string;
  kind: ComponentKind;
  amountPaise: Money;
  reason?: string;
}

export interface PayrollInput {
  employee: {
    id: string;
    code: string;
    name: string;
    /** Days the employee was actually on the rolls within the period. */
    joinedOn: DateOnly;
    exitOn?: DateOnly | null;
  };
  period: { year: number; month: number; start: DateOnly; end: DateOnly };
  /** Declared monthly salary. Segments may override it (training, mid-month revision). */
  ctcMonthlyPaise: Money;
  segments: EmploymentSegment[];
  calendar: {
    totalDays: number;
    workingDays: number;
    weekOffDays: number;
    holidayDays: number;
    paidHolidayDays: number;
  };
  ledger: DayLedgerEntry[];
  advances: AdvanceInput[];
  adjustments: AdjustmentInput[];
  /**
   * Week offs a month this person's role is owed, overriding the payroll rule.
   *
   * Three layers, the same shape leave allocation already has: the designation,
   * then the payroll rule, then the weekly-off pattern. Undefined and null both
   * mean "ask the layer above" -- and they have to, because a designation that
   * has simply never been set must not read as "this role gets no rest days".
   */
  weekOffQuota?: number | null;
  /** Components may be overridden per employee; falls back to the policy's list. */
  componentOverrides?: SalaryComponent[] | null;
}

// ------------------------------------------------------------------ outputs

export interface LineItem {
  code: string;
  label: string;
  amountPaise: Money;
  kind: ComponentKind;
  prorated: boolean;
  showOnSlip: boolean;
}

export interface TraceLine {
  stage: string;
  label: string;
  formula: string;
  inputs: Record<string, string | number>;
  amountPaise: Money;
}

export interface DayCounts {
  basisDays: number;
  payableDays: number;
  presentDays: number;
  halfDays: number;
  absentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  weekOffDays: number;
  holidayDays: number;
  extraDays: number;
  lateCount: number;
  earlyLeaveCount: number;
  overtimeMinutes: number;
}

export interface CompOffCredit {
  leaveTypeCode: string;
  days: number;
}

export interface PayrollResult {
  employeeId: string;
  period: { year: number; month: number };
  ctcMonthlyPaise: Money;
  days: DayCounts;
  earnings: LineItem[];
  deductions: LineItem[];
  grossPaise: Money;
  totalEarningsPaise: Money;
  totalDeductionsPaise: Money;
  advanceRecoveredPaise: Money;
  advanceRecoveries: { advanceId: string; amountPaise: Money }[];
  netPaise: Money;
  compOffCredits: CompOffCredit[];
  trace: TraceLine[];
  warnings: string[];
}
