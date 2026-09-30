import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, requireWritable } from "@/lib/auth/guard";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { enforce } from "@/lib/ratelimit";
import { complete, extractJson } from "@/lib/ai/openrouter";
import { analyzePolicy, describePolicy, type Finding } from "@/domain/payroll/analyze";
import { safeParsePayrollPolicy } from "@/domain/payroll/policy";
import { simulatePayroll, SIMULATION_PRESETS } from "@/domain/payroll/simulate";
import type { PayrollPolicy, PayrollResult } from "@/domain/payroll/types";
import { getPayrollPolicy, savePolicyVersion } from "../policy";
import { todayInZone } from "@/domain/date";

/**
 * AI-assisted payroll configuration.
 *
 * The pipeline is deliberately narrow, because the thing being generated decides
 * what people get paid:
 *
 *   natural language
 *     → the model returns JSON (and nothing else)
 *     → zod parses it against the real policy schema — anything unrecognised is rejected
 *     → the analyser reports conflicts, assumptions and what changed
 *     → the same engine that runs payroll produces sample payslips
 *     → an admin reads all of that and clicks Approve
 *     → only then is a new policy version written
 *
 * The model never touches the database. It cannot activate anything, it cannot
 * run code, and a response that does not parse is discarded rather than patched
 * into something plausible.
 */

const SYSTEM_PROMPT = `You convert an organisation's payroll rules, written in plain language, into a strict JSON configuration.

Return ONLY a JSON object. No prose, no markdown fences, no explanation.

The object must match this shape exactly:

{
  "version": 1,
  "cycle": { "type": "MONTHLY", "startDay": 1 },
  "payableDaysBasis": "CALENDAR_DAYS" | "FIXED_30" | "WORKING_DAYS" | "WORKING_DAYS_PLUS_PAID_OFF",
  "percentBase": "CTC" | "CTC_MINUS_FIXED",
  "components": [
    {
      "code": "UPPER_SNAKE_CASE",
      "name": "Human name",
      "kind": "EARNING" | "DEDUCTION",
      "calc": { "type": "PERCENT_OF_CTC", "percent": 50 }
            | { "type": "PERCENT_OF_COMPONENT", "of": "BASIC", "percent": 40 }
            | { "type": "FIXED", "amountPaise": 500000 }
            | { "type": "BALANCE" },
      "prorated": true, "taxable": true, "showOnSlip": true, "sortOrder": 1
    }
  ],
  "attendance": {
    "late": { "type": "NONE" }
          | { "type": "PER_OCCURRENCE", "freeCount": 2, "amountPaise": 50000 }
          | { "type": "HALF_DAY_PER_N", "n": 3, "freeCount": 0 }
          | { "type": "PRORATA_MINUTES", "freeMinutes": 0 },
    "earlyLeave": same shape as late,
    "absent": { "type": "PER_DAY_RATE" } | { "type": "FIXED_PER_DAY", "amountPaise": 100000 } | { "type": "MULTIPLIER", "multiplier": 2 },
    "halfDayFactor": 0.5,
    "unpaidLeaveUsesPerDayRate": true   // always true; no calculation reads it
  },
  "overtime": {
    "enabled": true,
    "rate": { "type": "MULTIPLIER", "value": 1.5 } | { "type": "FLAT_PER_HOUR", "amountPaise": 20000 },
    "hourlyBasis": "CTC_PER_HOUR" | "BASIC_PER_HOUR",
    "standardHoursPerDay": 8,
    "maxPayableMinutesPerMonth": 0
  },
  "extraDay": { "mode": "NORMAL_DAY" }
            | { "mode": "MULTIPLIER", "multiplier": 1 }
            | { "mode": "OVERTIME_RATE" }
            | { "mode": "COMP_OFF", "leaveTypeCode": "COMP_OFF", "daysPerExtraDay": 1 },
  "leave": { "paidLeaveIsPayable": true, "unpaidLeaveDeducted": true, "weekOffPayable": true, "holidayPayable": true, "sandwichUnpaid": false },
  // Always leave "sandwichUnpaid" false and "unpaidLeaveUsesPerDayRate" true.
  // Both are in the schema and neither is read by any calculation, so proposing
  // a change to either promises somebody a rule that will not happen.
  "advance": { "defaultMode": { "mode": "FULL_NEXT" } | { "mode": "INSTALLMENTS", "installments": 4 } | { "mode": "FIXED_PER_MONTH", "amountPaise": 100000 } | { "mode": "PERCENT_OF_NET", "percent": 20 } | { "mode": "MANUAL" }, "minNetPayPaise": 0 },
  "training": { "prorateAcrossTransition": true, "defaultMode": "PERCENT" | "FIXED" | "UNPAID", "defaultPercent": 100 },
  "statutory": {
    "providentFund": { "enabled": false, "employeePercent": 12, "wageCeilingPaise": 1500000, "componentCode": "BASIC" },
    "esi": { "enabled": false, "employeePercent": 0.75, "wageCeilingPaise": 2100000 },
    "professionalTax": { "enabled": false, "slabs": [] },
    "incomeTax": { "enabled": false, "monthlyFlatPaise": 0 }
  },
  "rounding": { "mode": "NONE" | "NEAREST" | "UP" | "DOWN", "to": 100 },
  "stages": ["PRORATE_EARNINGS","LATE_DEDUCTION","EARLY_LEAVE_DEDUCTION","UNPAID_LEAVE_DEDUCTION","EXTRA_DAY_CREDIT","OVERTIME_CREDIT","ADJUSTMENTS","STATUTORY_DEDUCTIONS","ADVANCE_RECOVERY","ROUNDING"]

Rules you must follow:
- ALL money is an integer number of PAISE. ₹500 is 50000. Never use rupees or decimals.
- Percentage EARNING components must total exactly 100, unless one uses {"type":"BALANCE"}.
- "extraDay" MULTIPLIER is pay ON TOP of the rest day, which is already paid. "one extra day's salary" is multiplier 1; "double pay" is multiplier 2.
- Keep every field. If the user did not mention something, carry over the current value.
- Do not invent components the user did not ask for.`;

export interface RuleProposal {
  /** The parsed, schema-valid policy. Never activated by this call. */
  policy: PayrollPolicy;
  /** Plain-English restatement, so an admin can check the model understood. */
  description: string[];
  findings: Finding[];
  blockers: Finding[];
  activatable: boolean;
  /** Sample payslips computed by the real engine under the proposed rules. */
  samples: {
    name: string;
    description: string;
    current: PayrollResult | null;
    proposed: PayrollResult;
  }[];
  model: string;
  tokensUsed: number;
}

/**
 * Turns a description of payroll rules into a proposal.
 *
 * Nothing is written except an audit row recording that generation happened.
 */
export async function generatePayrollRules(
  ctx: AuthContext,
  prompt: string,
): Promise<RuleProposal> {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.rules.manage");
  // Declared, granted and checked by nothing until now: the only way to deny
  // one person AI was to switch the module off for the whole organisation.
  requirePermission(ctx, "ai.use");
  requireModule(ctx, "ai");
  requireWritable(ctx);

  if (prompt.trim().length < 10) {
    throw new ValidationError("Describe your payroll rules in a sentence or two.");
  }
  await enforce("aiRequest", ctx.organizationId);

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const { policy: current } = await getPayrollPolicy(ctx, today);

  const completion = await complete(ctx.organizationId, {
    json: true,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          "This is the organisation's CURRENT payroll configuration:",
          JSON.stringify(current),
          "",
          "Apply the following changes, and return the COMPLETE updated configuration:",
          prompt.trim(),
        ].join("\n"),
      },
    ],
  });

  const raw = extractJson(completion.content);
  const parsed = safeParsePayrollPolicy(raw);

  // A response that does not fit the schema is discarded, not repaired. The
  // errors are shown so the admin can rephrase rather than guess.
  if (!parsed.success) {
    throw new ValidationError(
      "The AI produced a configuration that does not fit the payroll schema, so nothing was changed.",
      {
        issues: parsed.error.issues.slice(0, 12).map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    );
  }

  const policy = parsed.data as PayrollPolicy;
  const analysis = analyzePolicy(policy, current);

  await writeAudit(ctx, {
    action: "ai.rules_generated",
    entityType: "OrgPolicyVersion",
    metadata: {
      prompt: prompt.trim().slice(0, 500),
      model: completion.model,
      blockers: analysis.blockers.length,
      tokens: completion.promptTokens + completion.completionTokens,
    },
  });

  return {
    policy,
    description: describePolicy(policy),
    findings: analysis.findings,
    blockers: analysis.blockers,
    activatable: analysis.activatable,
    samples: buildSamples(current, policy),
    model: completion.model,
    tokensUsed: completion.promptTokens + completion.completionTokens,
  };
}

/**
 * Runs the same three scenarios under the old and new rules.
 *
 * Seeing "this employee currently gets ₹29,000 and would get ₹27,500" is the
 * check that catches a rule which is technically valid and financially wrong.
 */
function buildSamples(current: PayrollPolicy, proposed: PayrollPolicy): RuleProposal["samples"] {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();

  return SIMULATION_PRESETS.map((preset) => {
    const input = { ...preset.input, year, month };
    let currentResult: PayrollResult | null = null;
    try {
      currentResult = simulatePayroll(input, current).result;
    } catch {
      // The current policy failing on a synthetic case must not block the preview.
      currentResult = null;
    }
    return {
      name: preset.name,
      description: preset.description,
      current: currentResult,
      proposed: simulatePayroll(input, proposed).result,
    };
  });
}

/**
 * Activates a proposal, after a human has read it.
 *
 * The policy is re-parsed and re-analysed here rather than trusted from the
 * request: the browser holds a copy of the proposal, and a copy is not evidence.
 */
export async function activatePayrollRules(
  ctx: AuthContext,
  input: { policy: unknown; effectiveFrom: string; note?: string; aiPrompt?: string },
): Promise<{ version: number }> {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.rules.manage");
  requireWritable(ctx);

  const parsed = safeParsePayrollPolicy(input.policy);
  if (!parsed.success) {
    throw new ValidationError("That configuration is not valid and was not activated.", {
      issues: parsed.error.issues.slice(0, 12).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const policy = parsed.data as PayrollPolicy;
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const { policy: current } = await getPayrollPolicy(ctx, today);
  const analysis = analyzePolicy(policy, current);

  if (!analysis.activatable) {
    throw new ValidationError(
      "This configuration still has problems that must be fixed before it can be activated.",
      { issues: analysis.blockers.map((b) => ({ path: b.area, message: b.message })) },
    );
  }

  /**
   * A comp-off code has to name a leave type that exists.
   *
   * `creditCompOff` looks the code up at lock time and, finding nothing,
   * `continue`s -- then stamps `compOffCreditedAt` anyway. So a typo here does
   * not fail: it silently gives somebody who worked a rest day nothing, marks
   * the credit as done, and leaves no trace on the payslip or anywhere else.
   * The screen offers a list rather than a text box now; this is the other
   * door, because the AI rule builder can set the same field.
   *
   * Checked here rather than in `analyzePolicy` because that is pure and this
   * needs the organisation's own leave types.
   */
  if (policy.extraDay.mode === "COMP_OFF") {
    const code = policy.extraDay.leaveTypeCode;
    const type = await prisma.leaveType.findFirst({
      where: { organizationId: ctx.organizationId!, code, active: true },
      select: { id: true },
    });
    if (!type) {
      throw new ValidationError(
        `No active leave type has the code ${code}, so a compensatory off credited to it would go nowhere. Create the type first, or pick another.`,
        { issues: [{ path: "extraDay.leaveTypeCode", message: `${code} does not exist` }] },
      );
    }
  }

  // A policy takes effect from a date, so payroll already run for an earlier
  // period keeps using the rules it was calculated under.
  const { version } = await savePolicyVersion(ctx, "PAYROLL", policy, {
    effectiveFrom: input.effectiveFrom,
    note: input.note,
    aiGenerated: Boolean(input.aiPrompt),
    aiPrompt: input.aiPrompt,
  });

  // Keep the salary-component table in step, since the structure editor reads it.
  await syncComponents(ctx.organizationId, policy);

  await writeAudit(ctx, {
    action: "ai.rules_activated",
    entityType: "OrgPolicyVersion",
    after: {
      version,
      effectiveFrom: input.effectiveFrom,
      aiGenerated: Boolean(input.aiPrompt),
      components: policy.components.length,
    },
  });

  return { version };
}

async function syncComponents(organizationId: string, policy: PayrollPolicy): Promise<void> {
  const codes = policy.components.map((c) => c.code);

  await prisma.$transaction([
    // Components no longer in the policy are deactivated rather than deleted —
    // a historical salary profile may still reference one.
    prisma.salaryComponent.updateMany({
      where: { organizationId, code: { notIn: codes } },
      data: { active: false },
    }),
    ...policy.components.map((c) =>
      prisma.salaryComponent.upsert({
        where: { organizationId_code: { organizationId, code: c.code } },
        create: {
          organizationId,
          code: c.code,
          name: c.name,
          kind: c.kind,
          calc: c.calc as object,
          prorated: c.prorated,
          taxable: c.taxable,
          showOnSlip: c.showOnSlip,
          sortOrder: c.sortOrder,
        },
        update: {
          name: c.name,
          kind: c.kind,
          calc: c.calc as object,
          prorated: c.prorated,
          taxable: c.taxable,
          showOnSlip: c.showOnSlip,
          sortOrder: c.sortOrder,
          active: true,
        },
      }),
    ),
  ]);
}

/** Analysis of a hand-edited policy, without involving the AI at all. */
export async function reviewPolicy(
  ctx: AuthContext,
  candidate: unknown,
): Promise<Omit<RuleProposal, "model" | "tokensUsed">> {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.rules.manage");

  const parsed = safeParsePayrollPolicy(candidate);
  if (!parsed.success) {
    throw new ValidationError("That configuration does not fit the payroll schema.", {
      issues: parsed.error.issues.slice(0, 12).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const policy = parsed.data as PayrollPolicy;
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const { policy: current } = await getPayrollPolicy(ctx, today);
  const analysis = analyzePolicy(policy, current);

  return {
    policy,
    description: describePolicy(policy),
    findings: analysis.findings,
    blockers: analysis.blockers,
    activatable: analysis.activatable,
    samples: buildSamples(current, policy),
  };
}
