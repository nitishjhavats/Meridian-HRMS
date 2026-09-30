import { describe, expect, it } from "vitest";
import { analyzePolicy, describePolicy } from "./analyze";
import { DEFAULT_PAYROLL_POLICY } from "./policy";
import type { PayrollPolicy } from "./types";

function policyWith(patch: (p: PayrollPolicy) => void): PayrollPolicy {
  const copy = structuredClone(DEFAULT_PAYROLL_POLICY) as PayrollPolicy;
  patch(copy);
  return copy;
}

const find = (result: ReturnType<typeof analyzePolicy>, area: string) =>
  result.findings.filter((f) => f.area === area);

describe("policy analysis", () => {
  it("passes the shipped default", () => {
    const result = analyzePolicy(DEFAULT_PAYROLL_POLICY);
    expect(result.blockers).toHaveLength(0);
    expect(result.activatable).toBe(true);
  });

  // The single most consequential mistake: a split that does not add up.
  it("blocks a salary split that does not total 100%", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.components = p.components.map((c) =>
          c.code === "BASIC" ? { ...c, calc: { type: "PERCENT_OF_CTC", percent: 70 } } : c,
        );
      }),
    );
    expect(result.activatable).toBe(false);
    expect(result.blockers[0]?.message).toContain("70%");
    expect(result.blockers[0]?.suggestion).toContain("30%");
  });

  it("accepts an under-100% split when a component absorbs the balance", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.components = [
          { code: "BASIC", name: "Basic", kind: "EARNING", calc: { type: "PERCENT_OF_CTC", percent: 60 }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 1 },
          { code: "SPECIAL", name: "Special", kind: "EARNING", calc: { type: "BALANCE" }, prorated: true, taxable: true, showOnSlip: true, sortOrder: 2 },
        ];
      }),
    );
    expect(result.activatable).toBe(true);
  });

  it("blocks a comp-off rule with no leave type named", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.extraDay = { mode: "COMP_OFF", leaveTypeCode: "  ", daysPerExtraDay: 1 };
      }),
    );
    expect(result.activatable).toBe(false);
    expect(result.blockers[0]?.area).toBe("Extra days");
  });

  it("blocks a nonsensical half-day factor", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.attendance.halfDayFactor = 1.5;
      }),
    );
    expect(result.activatable).toBe(false);
  });

  it("warns when overtime pays less than ordinary time", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.overtime.enabled = true;
        p.overtime.rate = { type: "MULTIPLIER", value: 0.5 };
      }),
    );
    expect(find(result, "Overtime").some((f) => f.severity === "WARNING")).toBe(true);
    // A warning must not stop activation — it is a judgement call, not an error.
    expect(result.activatable).toBe(true);
  });

  it("warns that unpaid week-offs will cut a monthly salary", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.leave.weekOffPayable = false;
      }),
    );
    const finding = find(result, "Leave").find((f) => f.message.includes("Week-offs are unpaid"));
    expect(finding?.severity).toBe("WARNING");
    expect(finding?.suggestion).toContain("daily-wage");
  });

  it("flags a late penalty that can never bite", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.attendance.late = { type: "PER_OCCURRENCE", freeCount: 2, amountPaise: 0 };
      }),
    );
    expect(find(result, "Late arrivals")[0]?.message).toContain("no effect");
  });

  it("notes an uncapped overtime bill as an assumption", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.overtime.enabled = true;
        p.overtime.maxPayableMinutesPerMonth = 0;
      }),
    );
    expect(find(result, "Overtime").some((f) => f.severity === "ASSUMPTION")).toBe(true);
  });

  it("orders blockers before warnings before assumptions", () => {
    const result = analyzePolicy(
      policyWith((p) => {
        p.attendance.halfDayFactor = 2; // blocker
        p.leave.weekOffPayable = false; // warning
        p.overtime.enabled = true; // assumption (uncapped)
        p.overtime.maxPayableMinutesPerMonth = 0;
      }),
    );
    const severities = result.findings.map((f) => f.severity);
    expect(severities.indexOf("BLOCKER")).toBeLessThan(severities.indexOf("WARNING"));
    expect(severities.indexOf("WARNING")).toBeLessThan(severities.indexOf("ASSUMPTION"));
  });
});

describe("policy diff", () => {
  it("describes what changed against the policy in force", () => {
    const proposed = policyWith((p) => {
      p.payableDaysBasis = "WORKING_DAYS";
      p.extraDay = { mode: "MULTIPLIER", multiplier: 2 };
    });
    const result = analyzePolicy(proposed, DEFAULT_PAYROLL_POLICY);

    const changes = result.findings.filter((f) => f.severity === "CHANGE");
    expect(changes.some((c) => c.message.includes("working days"))).toBe(true);
    expect(changes.some((c) => c.area === "Extra days")).toBe(true);
  });

  it("reports a percentage move on a named component", () => {
    const proposed = policyWith((p) => {
      p.components = p.components.map((c) =>
        c.code === "BASIC"
          ? { ...c, calc: { type: "PERCENT_OF_CTC", percent: 50 } }
          : c.code === "HRA"
            ? { ...c, calc: { type: "PERCENT_OF_CTC", percent: 50 } }
            : c,
      );
    });
    const result = analyzePolicy(proposed, DEFAULT_PAYROLL_POLICY);
    expect(
      result.findings.some((f) => f.message.includes("Basic Salary: 100% → 50%")),
    ).toBe(true);
  });

  // Dropping a component silently would blank a line on existing payslips.
  it("warns when a component disappears", () => {
    const proposed = policyWith((p) => {
      p.components = p.components.filter((c) => c.code !== "HRA");
      p.components = p.components.map((c) =>
        c.code === "BASIC" ? { ...c, calc: { type: "PERCENT_OF_CTC", percent: 100 } } : c,
      );
    });
    const result = analyzePolicy(proposed, DEFAULT_PAYROLL_POLICY);
    const warning = result.findings.find((f) => f.message.includes("Components removed"));
    expect(warning?.severity).toBe("WARNING");
    expect(warning?.message).toContain("HRA");
  });

  it("says nothing about changes when there is no current policy", () => {
    const result = analyzePolicy(DEFAULT_PAYROLL_POLICY);
    expect(result.findings.filter((f) => f.severity === "CHANGE")).toHaveLength(0);
  });
});

describe("plain-English description", () => {
  it("restates the default policy readably", () => {
    const lines = describePolicy(DEFAULT_PAYROLL_POLICY);
    expect(lines.join(" ")).toContain("days in the month");
    expect(lines.join(" ")).toContain("Late arrivals are recorded but not deducted");
    expect(lines.join(" ")).toContain("Overtime is not paid");
  });

  it("describes a rest-day multiplier in words", () => {
    const lines = describePolicy(
      policyWith((p) => {
        p.extraDay = { mode: "MULTIPLIER", multiplier: 2 };
      }),
    );
    expect(lines.join(" ")).toContain("2× a day's pay on top of the rest day");
  });

  it("describes the late rule an organisation actually asked for", () => {
    // "Two lates above 15 minutes should cost half a day."
    const lines = describePolicy(
      policyWith((p) => {
        p.attendance.late = { type: "HALF_DAY_PER_N", n: 2, freeCount: 0 };
      }),
    );
    expect(lines.join(" ")).toContain("every 2 lates cost half a day");
  });

  it("names the comp-off leave type", () => {
    const lines = describePolicy(
      policyWith((p) => {
        p.extraDay = { mode: "COMP_OFF", leaveTypeCode: "COMP_OFF", daysPerExtraDay: 1 };
      }),
    );
    expect(lines.join(" ")).toContain("COMP_OFF");
  });
});
