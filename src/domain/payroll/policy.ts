/**
 * Payroll policy: zod schema, defaults, and salary-structure resolution.
 *
 * The zod schema is the trust boundary for AI-generated configuration — nothing
 * reaches `OrgPolicyVersion` without parsing cleanly here first.
 */

import { z } from "zod";
import { type Money, formatPaise, pct, sum } from "../money";
import type {
  ComponentCalc,
  PayrollPolicy,
  PercentBase,
  SalaryComponent,
} from "./types";

// ------------------------------------------------------------------ zod schema

const moneySchema = z.number().int().min(0);
const percentSchema = z.number().min(0).max(1000);

const componentCalcSchema: z.ZodType<ComponentCalc> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PERCENT_OF_CTC"), percent: percentSchema }),
  z.object({
    type: z.literal("PERCENT_OF_COMPONENT"),
    of: z.string().min(1),
    percent: percentSchema,
  }),
  z.object({ type: z.literal("FIXED"), amountPaise: moneySchema }),
  z.object({ type: z.literal("BALANCE") }),
]);

export const salaryComponentSchema: z.ZodType<SalaryComponent> = z.object({
  code: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Z0-9_]+$/, "Component code must be UPPER_SNAKE_CASE"),
  name: z.string().min(1).max(64),
  kind: z.enum(["EARNING", "DEDUCTION"]),
  calc: componentCalcSchema,
  prorated: z.boolean(),
  taxable: z.boolean(),
  showOnSlip: z.boolean(),
  sortOrder: z.number().int(),
});

const lateRuleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NONE") }),
  z.object({
    type: z.literal("PER_OCCURRENCE"),
    freeCount: z.number().int().min(0),
    amountPaise: moneySchema,
  }),
  z.object({
    type: z.literal("HALF_DAY_PER_N"),
    n: z.number().int().min(1),
    freeCount: z.number().int().min(0),
  }),
  z.object({ type: z.literal("PRORATA_MINUTES"), freeMinutes: z.number().int().min(0) }),
]);

export const payrollPolicySchema = z.object({
  version: z.number().int().min(1),
  cycle: z.object({
    type: z.literal("MONTHLY"),
    startDay: z.number().int().min(1).max(28),
  }),
  payableDaysBasis: z.enum([
    "CALENDAR_DAYS",
    "FIXED_30",
    "WORKING_DAYS",
    "WORKING_DAYS_PLUS_PAID_OFF",
  ]),
  percentBase: z.enum(["CTC", "CTC_MINUS_FIXED"]),
  components: z.array(salaryComponentSchema).min(1),
  attendance: z.object({
    late: lateRuleSchema,
    earlyLeave: lateRuleSchema,
    absent: z.discriminatedUnion("type", [
      z.object({ type: z.literal("PER_DAY_RATE") }),
      z.object({ type: z.literal("FIXED_PER_DAY"), amountPaise: moneySchema }),
      z.object({ type: z.literal("MULTIPLIER"), multiplier: z.number().min(0).max(10) }),
    ]),
    halfDayFactor: z.number().min(0).max(1),
    unpaidLeaveUsesPerDayRate: z.boolean(),
  }),
  overtime: z.object({
    enabled: z.boolean(),
    rate: z.discriminatedUnion("type", [
      z.object({ type: z.literal("MULTIPLIER"), value: z.number().min(0).max(10) }),
      z.object({ type: z.literal("FLAT_PER_HOUR"), amountPaise: moneySchema }),
    ]),
    hourlyBasis: z.enum(["CTC_PER_HOUR", "BASIC_PER_HOUR"]),
    standardHoursPerDay: z.number().min(1).max(24),
    maxPayableMinutesPerMonth: z.number().int().min(0),
  }),
  extraDay: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("NORMAL_DAY") }),
    z.object({ mode: z.literal("MULTIPLIER"), multiplier: z.number().min(0).max(10) }),
    z.object({ mode: z.literal("OVERTIME_RATE") }),
    z.object({
      mode: z.literal("COMP_OFF"),
      leaveTypeCode: z.string().min(1),
      daysPerExtraDay: z.number().min(0).max(5),
    }),
  ]),
  /**
   * `.default()`, not required, and the distinction is load-bearing.
   *
   * `getPayrollPolicy` is deliberately strict: a stored payload that will not
   * parse drops the whole organisation onto `DEFAULT_PAYROLL_POLICY` rather
   * than being silently patched, because a malformed policy must never quietly
   * pay everyone the wrong amount. Every policy on this instance was written
   * before this key existed -- so making it required would have failed all of
   * them, reverting live salary components to the shipped defaults in the
   * middle of a payroll month. A default fills the gap on read and leaves the
   * stored row untouched.
   */
  weekOff: z
    .object({
      quotaPerMonth: z.number().int().min(0).max(31).nullable(),
      paid: z.boolean(),
      payUnused: z.object({
        enabled: z.boolean(),
        rate: z.discriminatedUnion("type", [
          z.object({ type: z.literal("NORMAL_DAY") }),
          z.object({ type: z.literal("MULTIPLIER"), value: z.number().min(0).max(10) }),
          z.object({ type: z.literal("OVERTIME_RATE") }),
        ]),
      }),
    })
    .default({
      quotaPerMonth: null,
      paid: true,
      payUnused: { enabled: false, rate: { type: "NORMAL_DAY" } },
    }),
  leave: z.object({
    paidLeaveIsPayable: z.boolean(),
    unpaidLeaveDeducted: z.boolean(),
    weekOffPayable: z.boolean(),
    holidayPayable: z.boolean(),
    sandwichUnpaid: z.boolean(),
  }),
  advance: z.object({
    defaultMode: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("FULL_NEXT") }),
      z.object({ mode: z.literal("INSTALLMENTS"), installments: z.number().int().min(1).max(60) }),
      z.object({ mode: z.literal("FIXED_PER_MONTH"), amountPaise: moneySchema }),
      z.object({ mode: z.literal("PERCENT_OF_NET"), percent: z.number().min(0).max(100) }),
      z.object({ mode: z.literal("MANUAL") }),
    ]),
    minNetPayPaise: moneySchema,
  }),
  training: z.object({
    prorateAcrossTransition: z.boolean(),
    defaultMode: z.enum(["PERCENT", "FIXED", "UNPAID"]),
    defaultPercent: z.number().min(0).max(100),
  }),
  statutory: z.object({
    providentFund: z.object({
      enabled: z.boolean(),
      employeePercent: z.number().min(0).max(100),
      wageCeilingPaise: moneySchema,
      componentCode: z.string().min(1),
    }),
    esi: z.object({
      enabled: z.boolean(),
      employeePercent: z.number().min(0).max(100),
      wageCeilingPaise: moneySchema,
    }),
    professionalTax: z.object({
      enabled: z.boolean(),
      slabs: z.array(z.object({ uptoPaise: moneySchema, amountPaise: moneySchema })),
    }),
    incomeTax: z.object({ enabled: z.boolean(), monthlyFlatPaise: moneySchema }),
  }),
  rounding: z.object({
    mode: z.enum(["NONE", "NEAREST", "UP", "DOWN"]),
    to: z.number().int().min(1),
  }),
  stages: z.array(
    z.enum([
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
    ]),
  ),
}) satisfies z.ZodType<PayrollPolicy, z.ZodTypeDef, unknown>;

// ------------------------------------------------------------------ defaults

/**
 * The out-of-the-box structure the product ships with: everything in BASIC, and
 * the other components present at 0 % so an admin only has to change numbers.
 */
export const DEFAULT_COMPONENTS: SalaryComponent[] = [
  { code: "BASIC", name: "Basic Salary", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 100 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 1 },
  { code: "HRA", name: "House Rent Allowance", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 0 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 2 },
  { code: "ALLOWANCE", name: "Special Allowance", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 0 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 3 },
  { code: "BONUS", name: "Bonus", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 0 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 4 },
  { code: "OTHER", name: "Other Allowance", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 0 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 5 },
];

export const DEFAULT_PAYROLL_POLICY: PayrollPolicy = {
  version: 1,
  cycle: { type: "MONTHLY", startDay: 1 },
  payableDaysBasis: "CALENDAR_DAYS",
  percentBase: "CTC",
  components: DEFAULT_COMPONENTS,
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
  weekOff: {
    quotaPerMonth: null,
    paid: true,
    // Off. A shipped default that pays more reaches every organisation on
    // deploy and changes a salary nobody asked to change.
    payUnused: { enabled: false, rate: { type: "NORMAL_DAY" } },
  },
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
    providentFund: { enabled: false, employeePercent: 12, wageCeilingPaise: 1_500_000, componentCode: "BASIC" },
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

// ------------------------------------------------------------------ validation

export interface StructureIssue {
  code: string | null;
  message: string;
}

/**
 * Structural rules for a salary structure. Percent-of-CTC earnings must total
 * exactly 100 %, unless a BALANCE component exists to absorb the remainder — in
 * which case they must total at most 100 %.
 */
export function validateSalaryStructure(
  components: readonly SalaryComponent[],
  percentBase: PercentBase = "CTC",
): StructureIssue[] {
  const issues: StructureIssue[] = [];

  if (components.length === 0) {
    return [{ code: null, message: "At least one salary component is required." }];
  }

  const seen = new Set<string>();
  for (const c of components) {
    if (seen.has(c.code)) issues.push({ code: c.code, message: `Duplicate component code "${c.code}".` });
    seen.add(c.code);
  }

  const earnings = components.filter((c) => c.kind === "EARNING");
  if (earnings.length === 0) {
    issues.push({ code: null, message: "A salary structure needs at least one earning component." });
  }

  const balances = earnings.filter((c) => c.calc.type === "BALANCE");
  if (balances.length > 1) {
    issues.push({
      code: balances[1]?.code ?? null,
      message: "Only one component can absorb the balance.",
    });
  }

  // PERCENT_OF_COMPONENT must point at something real, and must not cycle.
  for (const c of components) {
    if (c.calc.type !== "PERCENT_OF_COMPONENT") continue;
    if (!seen.has(c.calc.of)) {
      issues.push({ code: c.code, message: `"${c.code}" refers to unknown component "${c.calc.of}".` });
    }
  }
  for (const cycle of findCycles(components)) {
    issues.push({ code: cycle[0] ?? null, message: `Circular component reference: ${cycle.join(" → ")}.` });
  }

  const percentTotal = earnings.reduce(
    (acc, c) => (c.calc.type === "PERCENT_OF_CTC" ? acc + c.calc.percent : acc),
    0,
  );
  const rounded = Math.round(percentTotal * 1000) / 1000;

  if (balances.length === 0) {
    if (rounded !== 100) {
      issues.push({
        code: null,
        message:
          percentBase === "CTC"
            ? `Percentage components must total exactly 100 %. They currently total ${rounded} %.`
            : `Percentage components must total exactly 100 % of the amount left after fixed components. They currently total ${rounded} %.`,
      });
    }
  } else if (rounded > 100) {
    issues.push({
      code: null,
      message: `Percentage components total ${rounded} %, which leaves nothing for the balance component.`,
    });
  }

  return issues;
}

function findCycles(components: readonly SalaryComponent[]): string[][] {
  const byCode = new Map(components.map((c) => [c.code, c]));
  const cycles: string[][] = [];
  const state = new Map<string, "VISITING" | "DONE">();

  const walk = (code: string, path: string[]): void => {
    if (state.get(code) === "DONE") return;
    if (state.get(code) === "VISITING") {
      const start = path.indexOf(code);
      cycles.push([...path.slice(start), code]);
      return;
    }
    state.set(code, "VISITING");
    const node = byCode.get(code);
    if (node?.calc.type === "PERCENT_OF_COMPONENT" && byCode.has(node.calc.of)) {
      walk(node.calc.of, [...path, code]);
    }
    state.set(code, "DONE");
  };

  for (const c of components) walk(c.code, []);
  return cycles;
}

// ------------------------------------------------------------------ resolution

export interface ResolvedComponent {
  component: SalaryComponent;
  amountPaise: Money;
  formula: string;
}

export interface ResolvedStructure {
  earnings: ResolvedComponent[];
  deductions: ResolvedComponent[];
  grossPaise: Money;
  /** Paise added to or removed from a component to make the total match CTC exactly. */
  roundingResidualPaise: Money;
}

/**
 * Turns a declared monthly CTC into per-component amounts.
 *
 * Fixed components are honoured first; percentages then apply to either the full
 * CTC or the remainder, per `percentBase`. Any paise lost to rounding is pushed
 * into the balance component (or the largest percentage earning) so the
 * components always add up to the CTC exactly — payroll that is off by one paise
 * from the declared salary is a support ticket waiting to happen.
 */
export function resolveSalaryStructure(
  ctcMonthlyPaise: Money,
  components: readonly SalaryComponent[],
  percentBase: PercentBase = "CTC",
): ResolvedStructure {
  const ordered = [...components].sort((a, b) => a.sortOrder - b.sortOrder);
  const amounts = new Map<string, Money>();
  const formulas = new Map<string, string>();

  const fixedTotal = sum(
    ordered.filter((c) => c.kind === "EARNING" && c.calc.type === "FIXED").map((c) =>
      c.calc.type === "FIXED" ? c.calc.amountPaise : 0,
    ),
  );
  const base = percentBase === "CTC_MINUS_FIXED" ? Math.max(0, ctcMonthlyPaise - fixedTotal) : ctcMonthlyPaise;

  // Pass 1: everything that does not depend on another component.
  for (const c of ordered) {
    switch (c.calc.type) {
      case "FIXED":
        amounts.set(c.code, c.calc.amountPaise);
        formulas.set(c.code, `fixed ${formatPaise(c.calc.amountPaise)}`);
        break;
      case "PERCENT_OF_CTC":
        amounts.set(c.code, pct(base, c.calc.percent));
        formulas.set(
          c.code,
          `${c.calc.percent}% of ${percentBase === "CTC" ? "CTC" : "CTC − fixed"} (${formatPaise(base)})`,
        );
        break;
      default:
        break;
    }
  }

  // Pass 2: percent-of-component, resolved by dependency depth.
  for (let pass = 0; pass < 8; pass++) {
    let progressed = false;
    for (const c of ordered) {
      if (c.calc.type !== "PERCENT_OF_COMPONENT" || amounts.has(c.code)) continue;
      const source = amounts.get(c.calc.of);
      if (source == null) continue;
      amounts.set(c.code, pct(source, c.calc.percent));
      formulas.set(c.code, `${c.calc.percent}% of ${c.calc.of} (${formatPaise(source)})`);
      progressed = true;
    }
    if (!progressed) break;
  }
  // Unresolvable references (cycle or missing target) resolve to zero rather than
  // throwing; `validateSalaryStructure` is what refuses to save such a structure.
  for (const c of ordered) {
    if (!amounts.has(c.code)) {
      amounts.set(c.code, 0);
      formulas.set(c.code, "unresolved reference → 0");
    }
  }

  // Pass 3: the balance component absorbs whatever is left of the CTC.
  const balance = ordered.find((c) => c.kind === "EARNING" && c.calc.type === "BALANCE");
  if (balance) {
    const others = sum(
      ordered
        .filter((c) => c.kind === "EARNING" && c.code !== balance.code)
        .map((c) => amounts.get(c.code) ?? 0),
    );
    const remainder = Math.max(0, ctcMonthlyPaise - others);
    amounts.set(balance.code, remainder);
    formulas.set(
      balance.code,
      `CTC (${formatPaise(ctcMonthlyPaise)}) − other earnings (${formatPaise(others)})`,
    );
  }

  // Pass 4: absorb rounding drift so earnings total the CTC exactly.
  const earningComponents = ordered.filter((c) => c.kind === "EARNING");
  const earningTotal = sum(earningComponents.map((c) => amounts.get(c.code) ?? 0));
  let residual = ctcMonthlyPaise - earningTotal;

  if (residual !== 0 && earningComponents.length > 0) {
    const target =
      balance ??
      [...earningComponents]
        .filter((c) => c.calc.type === "PERCENT_OF_CTC")
        .sort((a, b) => (amounts.get(b.code) ?? 0) - (amounts.get(a.code) ?? 0))[0] ??
      earningComponents[0];

    if (target) {
      const adjusted = (amounts.get(target.code) ?? 0) + residual;
      // Never let the adjustment drive a component negative.
      if (adjusted >= 0) {
        amounts.set(target.code, adjusted);
        formulas.set(
          target.code,
          `${formulas.get(target.code) ?? ""} ${residual > 0 ? "+" : "−"} ${Math.abs(residual)} paise rounding`,
        );
      } else {
        residual = 0;
      }
    }
  }

  const toResolved = (c: SalaryComponent): ResolvedComponent => ({
    component: c,
    amountPaise: amounts.get(c.code) ?? 0,
    formula: formulas.get(c.code) ?? "",
  });

  const earnings = earningComponents.map(toResolved);
  const deductions = ordered.filter((c) => c.kind === "DEDUCTION").map(toResolved);

  return {
    earnings,
    deductions,
    grossPaise: sum(earnings.map((e) => e.amountPaise)),
    roundingResidualPaise: residual,
  };
}

/** Parse unknown JSON (including AI output) into a policy, or throw a zod error. */
export function parsePayrollPolicy(input: unknown): PayrollPolicy {
  return payrollPolicySchema.parse(input) as PayrollPolicy;
}

export function safeParsePayrollPolicy(input: unknown) {
  return payrollPolicySchema.safeParse(input);
}
