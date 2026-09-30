import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { requireModule, requirePermission } from "@/lib/auth/guard";
import { json, parseBody, route } from "@/lib/http/handler";
import { simulatePayroll } from "@/domain/payroll/simulate";
import { safeParsePayrollPolicy } from "@/domain/payroll/policy";
import { getPayrollPolicy } from "@/services/policy";
import { ValidationError } from "@/lib/errors";
import { todayInZone } from "@/domain/date";

/**
 * The rule sandbox.
 *
 * A hypothetical employee run through the real engine — no database writes, no
 * employee record. This is how an admin checks a policy before it touches
 * anyone's pay.
 */
const bodySchema = z.object({
  ctcMonthlyPaise: z.number().int().min(0).max(100_000_000),
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  presentDays: z.number().min(0).max(31),
  halfDays: z.number().min(0).max(31).optional(),
  absentDays: z.number().min(0).max(31).optional(),
  paidLeaveDays: z.number().min(0).max(31).optional(),
  unpaidLeaveDays: z.number().min(0).max(31).optional(),
  extraDays: z.number().min(0).max(31).optional(),
  weekOffDays: z.number().min(0).max(31).optional(),
  holidayDays: z.number().min(0).max(31).optional(),
  lateCount: z.number().min(0).max(31).optional(),
  lateMinutesEach: z.number().min(0).max(600).optional(),
  earlyLeaveCount: z.number().min(0).max(31).optional(),
  overtimeMinutes: z.number().min(0).max(20_000).optional(),
  advancePaise: z.number().int().min(0).max(100_000_000).optional(),
  training: z
    .object({
      mode: z.enum(["PERCENT", "FIXED", "UNPAID"]),
      percent: z.number().min(0).max(100).optional(),
      fixedAmountPaise: z.number().int().min(0).optional(),
    })
    .optional(),
  /** A personal or designation week-off quota to try; null asks the rule. */
  weekOffQuota: z.number().int().min(0).max(31).nullable().optional(),
  /** Try a draft policy instead of the one in force. */
  policy: z.unknown().optional(),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  requirePermission(ctx, "payroll.rules.manage");
  requireModule(ctx, "payroll");

  const body = await parseBody(request, bodySchema);

  let policy;
  if (body.policy) {
    const parsed = safeParsePayrollPolicy(body.policy);
    if (!parsed.success) throw new ValidationError("That draft policy is not valid.");
    policy = parsed.data;
  } else {
    const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
    policy = (await getPayrollPolicy(ctx, today)).policy;
  }

  const { result, unallocatedDays } = simulatePayroll(body, policy);
  return json({ result, unallocatedDays });
});
