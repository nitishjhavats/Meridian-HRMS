/**
 * Full & Final settlement (exit).
 *
 * When someone leaves, one statement has to reconcile everything that is still
 * owed in either direction: the final month's salary, unused leave, gratuity,
 * notice-period shortfall, outstanding advances and unreturned assets.
 *
 * Like payroll, this is pure and explainable: every line carries its formula, and
 * an approved settlement is frozen against a snapshot so later policy edits
 * cannot rewrite history.
 */

import { z } from "zod";
import { type Money, applyRounding, formatPaise, mul, pct, sum } from "../money";
import { type DateOnly, diffDays } from "../date";
import type { ComponentKind, PayrollPolicy } from "./types";

export interface GratuityPolicy {
  enabled: boolean;
  /** Years of service before any gratuity is payable. */
  minYearsOfService: number;
  /** Days of wages per completed year. The Indian statutory figure is 15. */
  daysPerYear: number;
  /** Which component the daily wage is derived from. */
  basisComponentCode: string;
  /** Divisor turning a monthly figure into a daily wage. 26 is the usual convention. */
  monthlyDivisor: number;
  maxAmountPaise: number;
}

export interface LeaveEncashmentPolicy {
  enabled: boolean;
  /** Leave type codes that may be encashed. */
  leaveTypeCodes: string[];
  maxDays: number;
  basisComponentCode: string;
  monthlyDivisor: number;
}

export interface NoticeRecoveryPolicy {
  enabled: boolean;
  /** Recover unserved notice at the per-day rate of this component. */
  basisComponentCode: string;
  monthlyDivisor: number;
}

export interface FnfPolicy {
  gratuity: GratuityPolicy;
  leaveEncashment: LeaveEncashmentPolicy;
  noticeRecovery: NoticeRecoveryPolicy;
}

export const DEFAULT_FNF_POLICY: FnfPolicy = {
  gratuity: {
    enabled: false,
    minYearsOfService: 5,
    daysPerYear: 15,
    basisComponentCode: "BASIC",
    monthlyDivisor: 26,
    maxAmountPaise: 0,
  },
  leaveEncashment: {
    enabled: true,
    leaveTypeCodes: ["EL"],
    maxDays: 30,
    basisComponentCode: "BASIC",
    monthlyDivisor: 26,
  },
  noticeRecovery: { enabled: true, basisComponentCode: "BASIC", monthlyDivisor: 30 },
};

export interface FnfInput {
  employee: { id: string; name: string; joinedOn: DateOnly };
  lastWorkingDay: DateOnly;
  /** Final month's net pay, already computed by the payroll engine. */
  finalSalaryPaise: Money;
  /** Monthly value of the component gratuity/encashment are based on. */
  basisComponentMonthlyPaise: Money;
  /** Encashable balances, by leave type code. */
  leaveBalances: { leaveTypeCode: string; days: number }[];
  noticeDaysRequired: number;
  noticeDaysServed: number;
  /** Outstanding advance balances at exit. */
  advanceOutstandingPaise: Money;
  /** Recovery for assets not returned. */
  assetRecoveryPaise: Money;
  /** Any other manual line the HR team adds. */
  adjustments: { code: string; label: string; kind: ComponentKind; amountPaise: Money; reason?: string }[];
}

export interface FnfLine {
  code: string;
  label: string;
  kind: ComponentKind;
  amountPaise: Money;
  formula: string;
  sortOrder: number;
}

export interface FnfResult {
  employeeId: string;
  lines: FnfLine[];
  earningsPaise: Money;
  deductionsPaise: Money;
  netPaise: Money;
  yearsOfService: number;
  warnings: string[];
}

/** Completed years of service, used for gratuity eligibility. */
/**
 * Money inside a formula.
 *
 * The statement is read by the person receiving the money, and "230769/day" is
 * paise — the same leak that once made payroll traces unreadable.
 *
 * These strings are drawn into a PDF, and how money is written there depends on
 * whether the PDF font carries the rupee sign — which this layer cannot know
 * and must not import, because everything under `domain/` is framework-free and
 * testable without a filesystem. So the formatter is injected, and the default
 * is the rupee form: a caller that cannot render it passes its own.
 */
type MoneyFormatter = (paise: Money) => string;

export function yearsOfService(joinedOn: DateOnly, lastWorkingDay: DateOnly): number {
  const days = diffDays(joinedOn, lastWorkingDay) + 1;
  return days / 365.25;
}

export function computeFnf(
  input: FnfInput,
  fnfPolicy: FnfPolicy,
  payrollPolicy: PayrollPolicy,
  money: MoneyFormatter = formatPaise,
): FnfResult {
  const lines: FnfLine[] = [];
  const warnings: string[] = [];
  const service = yearsOfService(input.employee.joinedOn, input.lastWorkingDay);

  // 1 — final month's salary
  lines.push({
    code: "FINAL_SALARY",
    label: "Final month salary",
    kind: "EARNING",
    amountPaise: input.finalSalaryPaise,
    formula: "net pay from the final payroll run",
    sortOrder: 1,
  });

  // 2 — leave encashment
  if (fnfPolicy.leaveEncashment.enabled) {
    const perDay = Math.round(
      input.basisComponentMonthlyPaise / fnfPolicy.leaveEncashment.monthlyDivisor,
    );
    const encashable = input.leaveBalances.filter((b) =>
      fnfPolicy.leaveEncashment.leaveTypeCodes.includes(b.leaveTypeCode),
    );
    const rawDays = sum(encashable.map((b) => Math.max(0, b.days)));
    const days = Math.min(rawDays, fnfPolicy.leaveEncashment.maxDays);
    if (days > rawDays) warnings.push("Leave encashment was capped by policy.");

    if (days > 0) {
      lines.push({
        code: "LEAVE_ENCASHMENT",
        label: "Leave encashment",
        kind: "EARNING",
        amountPaise: mul(perDay, days),
        formula: `${days} day(s) × ${money(perDay)}/day (${fnfPolicy.leaveEncashment.basisComponentCode} ÷ ${fnfPolicy.leaveEncashment.monthlyDivisor})`,
        sortOrder: 2,
      });
    }
  }

  // 3 — gratuity
  if (fnfPolicy.gratuity.enabled) {
    if (service >= fnfPolicy.gratuity.minYearsOfService) {
      const perDay = Math.round(input.basisComponentMonthlyPaise / fnfPolicy.gratuity.monthlyDivisor);
      const completedYears = Math.floor(service);
      const raw = mul(perDay, completedYears * fnfPolicy.gratuity.daysPerYear);
      const amount =
        fnfPolicy.gratuity.maxAmountPaise > 0 ? Math.min(raw, fnfPolicy.gratuity.maxAmountPaise) : raw;

      lines.push({
        code: "GRATUITY",
        label: "Gratuity",
        kind: "EARNING",
        amountPaise: amount,
        formula: `${completedYears} year(s) × ${fnfPolicy.gratuity.daysPerYear} days × ${money(perDay)}/day`,
        sortOrder: 3,
      });
      if (amount < raw) warnings.push("Gratuity was capped by the configured maximum.");
    } else {
      warnings.push(
        `Gratuity not payable: ${service.toFixed(1)} years of service is under the ${fnfPolicy.gratuity.minYearsOfService}-year minimum.`,
      );
    }
  }

  // 4 — notice shortfall recovery
  const shortfall = Math.max(0, input.noticeDaysRequired - input.noticeDaysServed);
  if (fnfPolicy.noticeRecovery.enabled && shortfall > 0) {
    const perDay = Math.round(
      input.basisComponentMonthlyPaise / fnfPolicy.noticeRecovery.monthlyDivisor,
    );
    lines.push({
      code: "NOTICE_RECOVERY",
      label: "Notice period recovery",
      kind: "DEDUCTION",
      amountPaise: mul(perDay, shortfall),
      formula: `${shortfall} unserved day(s) × ${money(perDay)}/day`,
      sortOrder: 4,
    });
  }

  // 5 — outstanding advances
  if (input.advanceOutstandingPaise > 0) {
    lines.push({
      code: "ADVANCE_RECOVERY",
      label: "Outstanding advance",
      kind: "DEDUCTION",
      amountPaise: input.advanceOutstandingPaise,
      formula: "full outstanding advance balance recovered at exit",
      sortOrder: 5,
    });
  }

  // 6 — unreturned assets
  if (input.assetRecoveryPaise > 0) {
    lines.push({
      code: "ASSET_RECOVERY",
      label: "Asset recovery",
      kind: "DEDUCTION",
      amountPaise: input.assetRecoveryPaise,
      formula: "value of assets not returned",
      sortOrder: 6,
    });
  }

  // 7 — manual adjustments
  input.adjustments.forEach((adj, i) => {
    lines.push({
      code: adj.code,
      label: adj.label,
      kind: adj.kind,
      amountPaise: adj.amountPaise,
      formula: adj.reason ? `manual — ${adj.reason}` : "manual adjustment",
      sortOrder: 7 + i,
    });
  });

  const earningsPaise = sum(lines.filter((l) => l.kind === "EARNING").map((l) => l.amountPaise));
  const deductionsPaise = sum(lines.filter((l) => l.kind === "DEDUCTION").map((l) => l.amountPaise));
  const netPaise = applyRounding(earningsPaise - deductionsPaise, payrollPolicy.rounding);

  if (netPaise < 0) {
    warnings.push(
      "The settlement is negative — the employee owes the organisation. Confirm recovery before approving.",
    );
  }

  return {
    employeeId: input.employee.id,
    lines: lines.filter((l) => l.amountPaise !== 0),
    earningsPaise,
    deductionsPaise,
    netPaise,
    yearsOfService: service,
    warnings,
  };
}

/** Percentage helper kept here so gratuity variants can be added without touching money.ts. */
export function proRataGratuity(basisMonthly: Money, months: number, daysPerYear: number, divisor: number): Money {
  const perDay = Math.round(basisMonthly / divisor);
  return mul(perDay, (months / 12) * daysPerYear);
}

export function encashmentValue(basisMonthly: Money, days: number, divisor: number): Money {
  return mul(Math.round(basisMonthly / divisor), days);
}

export { pct as percentOf };

// ------------------------------------------------------------------ validation

/**
 * The stored shape of an organisation's F&F rules.
 *
 * Gratuity is off by default and every figure is configurable: the spec is
 * explicit that statutory rules are per-organisation, not hard-coded to one
 * country's law.
 */
export const fnfPolicySchema = z.object({
  gratuity: z.object({
    enabled: z.boolean(),
    minYearsOfService: z.number().min(0).max(50),
    daysPerYear: z.number().min(0).max(365),
    basisComponentCode: z.string().min(1).max(40),
    monthlyDivisor: z.number().min(1).max(31),
    /** 0 means no cap. */
    maxAmountPaise: z.number().int().min(0),
  }),
  leaveEncashment: z.object({
    enabled: z.boolean(),
    leaveTypeCodes: z.array(z.string().min(1).max(20)),
    maxDays: z.number().min(0).max(365),
    basisComponentCode: z.string().min(1).max(40),
    monthlyDivisor: z.number().min(1).max(31),
  }),
  noticeRecovery: z.object({
    enabled: z.boolean(),
    basisComponentCode: z.string().min(1).max(40),
    monthlyDivisor: z.number().min(1).max(31),
  }),
});

export function safeParseFnfPolicy(input: unknown) {
  return fnfPolicySchema.safeParse(input);
}
