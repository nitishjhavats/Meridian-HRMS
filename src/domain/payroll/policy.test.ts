import { describe, expect, it } from "vitest";
import {
  DEFAULT_COMPONENTS,
  DEFAULT_PAYROLL_POLICY,
  resolveSalaryStructure,
  safeParsePayrollPolicy,
  validateSalaryStructure,
} from "./policy";
import type { SalaryComponent } from "./types";

const rupees = (n: number) => n * 100;

function component(
  code: string,
  calc: SalaryComponent["calc"],
  overrides: Partial<SalaryComponent> = {},
): SalaryComponent {
  return {
    code,
    name: code,
    kind: "EARNING",
    calc,
    prorated: true,
    taxable: true,
    showOnSlip: true,
    sortOrder: 1,
    ...overrides,
  };
}

describe("salary structure validation", () => {
  it("accepts the shipped default (BASIC 100 %, everything else 0 %)", () => {
    expect(validateSalaryStructure(DEFAULT_COMPONENTS)).toEqual([]);
  });

  it("requires percentages to total exactly 100", () => {
    const issues = validateSalaryStructure([
      component("BASIC", { type: "PERCENT_OF_CTC", percent: 50 }),
      component("HRA", { type: "PERCENT_OF_CTC", percent: 20 }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("70 %");
  });

  it("rejects a total above 100", () => {
    const issues = validateSalaryStructure([
      component("BASIC", { type: "PERCENT_OF_CTC", percent: 80 }),
      component("HRA", { type: "PERCENT_OF_CTC", percent: 40 }),
    ]);
    expect(issues).toHaveLength(1);
  });

  it("allows under 100 when a balance component absorbs the rest", () => {
    expect(
      validateSalaryStructure([
        component("BASIC", { type: "PERCENT_OF_CTC", percent: 60 }),
        component("SPECIAL", { type: "BALANCE" }),
      ]),
    ).toEqual([]);
  });

  it("allows only one balance component", () => {
    const issues = validateSalaryStructure([
      component("A", { type: "BALANCE" }),
      component("B", { type: "BALANCE" }),
    ]);
    expect(issues.some((i) => i.message.includes("Only one component"))).toBe(true);
  });

  it("catches duplicate codes", () => {
    const issues = validateSalaryStructure([
      component("BASIC", { type: "PERCENT_OF_CTC", percent: 50 }),
      component("BASIC", { type: "PERCENT_OF_CTC", percent: 50 }),
    ]);
    expect(issues.some((i) => i.message.includes("Duplicate"))).toBe(true);
  });

  it("catches a reference to a component that does not exist", () => {
    const issues = validateSalaryStructure([
      component("BASIC", { type: "PERCENT_OF_CTC", percent: 100 }),
      component("HRA", { type: "PERCENT_OF_COMPONENT", of: "NOPE", percent: 40 }),
    ]);
    expect(issues.some((i) => i.message.includes("unknown component"))).toBe(true);
  });

  it("catches a circular reference", () => {
    const issues = validateSalaryStructure([
      component("A", { type: "PERCENT_OF_COMPONENT", of: "B", percent: 50 }),
      component("B", { type: "PERCENT_OF_COMPONENT", of: "A", percent: 50 }),
    ]);
    expect(issues.some((i) => i.message.includes("Circular"))).toBe(true);
  });

  it("requires at least one earning", () => {
    const issues = validateSalaryStructure([
      component("PF", { type: "FIXED", amountPaise: 100 }, { kind: "DEDUCTION" }),
    ]);
    expect(issues.some((i) => i.message.includes("at least one earning"))).toBe(true);
  });
});

describe("salary structure resolution", () => {
  it("splits the CTC by percentage", () => {
    const resolved = resolveSalaryStructure(rupees(50_000), [
      component("BASIC", { type: "PERCENT_OF_CTC", percent: 50 }),
      component("HRA", { type: "PERCENT_OF_CTC", percent: 20 }, { sortOrder: 2 }),
      component("SPECIAL", { type: "PERCENT_OF_CTC", percent: 20 }, { sortOrder: 3 }),
      component("OTHER", { type: "PERCENT_OF_CTC", percent: 10 }, { sortOrder: 4 }),
    ]);
    expect(resolved.earnings.map((e) => e.amountPaise)).toEqual([
      rupees(25_000),
      rupees(10_000),
      rupees(10_000),
      rupees(5_000),
    ]);
    expect(resolved.grossPaise).toBe(rupees(50_000));
  });

  it("resolves a percentage of another component", () => {
    const resolved = resolveSalaryStructure(rupees(50_000), [
      component("BASIC", { type: "PERCENT_OF_CTC", percent: 50 }),
      component("HRA", { type: "PERCENT_OF_COMPONENT", of: "BASIC", percent: 40 }, { sortOrder: 2 }),
      component("SPECIAL", { type: "BALANCE" }, { sortOrder: 3 }),
    ]);
    const byCode = Object.fromEntries(resolved.earnings.map((e) => [e.component.code, e.amountPaise]));
    expect(byCode.BASIC).toBe(rupees(25_000));
    expect(byCode.HRA).toBe(rupees(10_000));
    expect(byCode.SPECIAL).toBe(rupees(15_000));
    expect(resolved.grossPaise).toBe(rupees(50_000));
  });

  it("applies percentages to the remainder when fixed components come first", () => {
    const resolved = resolveSalaryStructure(
      rupees(50_000),
      [
        component("CONVEYANCE", { type: "FIXED", amountPaise: rupees(5_000) }),
        component("BASIC", { type: "PERCENT_OF_CTC", percent: 60 }, { sortOrder: 2 }),
        component("HRA", { type: "PERCENT_OF_CTC", percent: 40 }, { sortOrder: 3 }),
      ],
      "CTC_MINUS_FIXED",
    );
    const byCode = Object.fromEntries(resolved.earnings.map((e) => [e.component.code, e.amountPaise]));
    expect(byCode.CONVEYANCE).toBe(rupees(5_000));
    expect(byCode.BASIC).toBe(rupees(27_000));
    expect(byCode.HRA).toBe(rupees(18_000));
    expect(resolved.grossPaise).toBe(rupees(50_000));
  });

  it("absorbs rounding drift so components always total the CTC exactly", () => {
    // 3 × 33.333 % of a value that does not divide evenly.
    const ctc = 1_000_001;
    const resolved = resolveSalaryStructure(ctc, [
      component("A", { type: "PERCENT_OF_CTC", percent: 33.333 }),
      component("B", { type: "PERCENT_OF_CTC", percent: 33.333 }, { sortOrder: 2 }),
      component("C", { type: "PERCENT_OF_CTC", percent: 33.334 }, { sortOrder: 3 }),
    ]);
    expect(resolved.grossPaise).toBe(ctc);
  });

  it("never drives a component negative while absorbing drift", () => {
    const resolved = resolveSalaryStructure(1, [
      component("A", { type: "PERCENT_OF_CTC", percent: 100 }),
    ]);
    expect(resolved.earnings.every((e) => e.amountPaise >= 0)).toBe(true);
  });

  it("gives every component a human-readable formula", () => {
    const resolved = resolveSalaryStructure(rupees(50_000), DEFAULT_COMPONENTS);
    for (const earning of resolved.earnings) {
      expect(earning.formula.length).toBeGreaterThan(0);
    }
  });
});

describe("policy schema", () => {
  it("accepts the default policy", () => {
    expect(safeParsePayrollPolicy(DEFAULT_PAYROLL_POLICY).success).toBe(true);
  });

  it("rejects an unknown deduction rule — the AI trust boundary", () => {
    const bad = structuredClone(DEFAULT_PAYROLL_POLICY) as unknown as Record<string, unknown>;
    (bad.attendance as Record<string, unknown>).late = { type: "DELETE_EVERYTHING" };
    expect(safeParsePayrollPolicy(bad).success).toBe(false);
  });

  it("rejects a component code that is not upper snake case", () => {
    const bad = structuredClone(DEFAULT_PAYROLL_POLICY) as unknown as Record<string, unknown>;
    (bad.components as { code: string }[])[0]!.code = "basic salary";
    expect(safeParsePayrollPolicy(bad).success).toBe(false);
  });

  it("rejects a negative fixed amount", () => {
    const bad = structuredClone(DEFAULT_PAYROLL_POLICY) as unknown as Record<string, unknown>;
    (bad.components as { calc: unknown }[])[0]!.calc = { type: "FIXED", amountPaise: -100 };
    expect(safeParsePayrollPolicy(bad).success).toBe(false);
  });

  it("rejects arbitrary extra keys being smuggled into a rule", () => {
    const result = safeParsePayrollPolicy({ nonsense: true });
    expect(result.success).toBe(false);
  });
});
