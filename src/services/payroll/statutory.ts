import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite } from "@/lib/auth/guard";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { todayInZone } from "@/domain/date";
import { payrollPolicySchema } from "@/domain/payroll/policy";
import { getPayrollPolicy, savePolicyVersion } from "@/services/policy";

/**
 * PF, ESI, professional tax and TDS, set by hand.
 *
 * These live inside the payroll policy, and the **only** screen that has ever
 * written that policy is the AI rule builder — a free-text prompt box. So an
 * organisation without an OpenRouter key could not switch provident fund on at
 * all: the four most common statutory deductions in Indian payroll were behind
 * a language model.
 *
 * This writes exactly the `statutory` block and leaves the rest of the policy
 * byte-identical, so turning PF on cannot quietly change a rounding rule or an
 * overtime multiplier. It publishes a new `OrgPolicyVersion` like every other
 * policy write, because a payroll run that has been locked must keep computing
 * from the policy it was locked against.
 *
 * All four ship `enabled: false`. That is the correct default and it stays:
 * nothing is deducted from anybody's pay because a screen was added.
 */

export interface StatutoryInput {
  providentFund: {
    enabled: boolean;
    employeePercent: number;
    /** Above this, PF stops accruing. Zero means no ceiling. */
    wageCeilingPaise: number;
    /** Which earning it is a percentage of. Usually BASIC. */
    componentCode: string;
  };
  esi: { enabled: boolean; employeePercent: number; wageCeilingPaise: number };
  professionalTax: {
    enabled: boolean;
    slabs: { uptoPaise: number; amountPaise: number }[];
  };
  incomeTax: { enabled: boolean; monthlyFlatPaise: number };
}

export async function getStatutory(ctx: AuthContext) {
  requireOrg(ctx);
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const { policy, isDefault } = await getPayrollPolicy(ctx, today);

  const components = await prisma.salaryComponent.findMany({
    where: { organizationId: ctx.organizationId!, active: true, kind: "EARNING" },
    select: { code: true, name: true },
    orderBy: { sortOrder: "asc" },
  });

  return { statutory: policy.statutory, isDefault, earningComponents: components };
}

export async function saveStatutory(ctx: AuthContext, input: StatutoryInput) {
  requireOrg(ctx);
  requireWrite(ctx, "payroll.rules.manage");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const { policy } = await getPayrollPolicy(ctx, today);

  if (input.providentFund.enabled) {
    const codes = await prisma.salaryComponent.findMany({
      where: { organizationId: ctx.organizationId!, active: true, kind: "EARNING" },
      select: { code: true },
    });
    // PF is a percentage *of a component*. Pointing it at one that does not
    // exist makes the engine fall back to gross, which silently deducts twelve
    // per cent of everything.
    if (!codes.some((c) => c.code === input.providentFund.componentCode)) {
      throw new ValidationError(
        `Provident fund is calculated on “${input.providentFund.componentCode}”, which is not one of your earnings.`,
      );
    }
  }

  if (input.professionalTax.enabled && input.professionalTax.slabs.length === 0) {
    throw new ValidationError("Professional tax needs at least one slab, or it deducts nothing.");
  }

  // Slabs are read in order by the engine, so an unsorted list makes the
  // deduction depend on the order somebody happened to type them in.
  const slabs = [...input.professionalTax.slabs].sort((a, b) => a.uptoPaise - b.uptoPaise);
  for (let i = 1; i < slabs.length; i++) {
    if (slabs[i]!.uptoPaise === slabs[i - 1]!.uptoPaise) {
      throw new ValidationError("Two professional tax slabs cover the same amount.");
    }
  }

  const next = { ...policy, statutory: { ...input, professionalTax: { ...input.professionalTax, slabs } } };

  // Parsed rather than trusted: this is the same document the AI builder
  // produces, and it reaches the engine unchanged.
  const parsed = payrollPolicySchema.safeParse(next);
  if (!parsed.success) {
    throw new ValidationError(
      `Those rules are not valid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }

  const { version } = await savePolicyVersion(ctx, "PAYROLL", parsed.data, {
    effectiveFrom: today,
    note: "Statutory deductions set by hand",
  });

  await writeAudit(ctx, {
    action: "payroll.statutory_updated",
    entityType: "OrgPolicyVersion",
    entityId: String(version),
    before: { statutory: policy.statutory },
    after: { statutory: parsed.data.statutory },
  });

  return { version, statutory: parsed.data.statutory };
}
