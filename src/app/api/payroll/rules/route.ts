import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  activatePayrollRules,
  generatePayrollRules,
  reviewPolicy,
} from "@/services/ai/payrollRules";
import { getPayrollPolicy } from "@/services/policy";
import { todayInZone } from "@/domain/date";

export const GET = route(async () => {
  const ctx = await requireContext();
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const { policy, isDefault, errors } = await getPayrollPolicy(ctx, today);
  return json({ policy, isDefault, errors });
});

/**
 * Three actions, one endpoint:
 *   generate — the AI proposes rules from a sentence. Writes nothing.
 *   review   — analyse a hand-edited policy. Writes nothing.
 *   activate — a human has read the proposal and accepts it. Writes a version.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate"), prompt: z.string().min(1).max(4000) }),
  z.object({ action: z.literal("review"), policy: z.unknown() }),
  z.object({
    action: z.literal("activate"),
    policy: z.unknown(),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().trim().max(300).optional(),
    aiPrompt: z.string().trim().max(4000).optional(),
  }),
]);

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);

  switch (body.action) {
    case "generate":
      return json({ proposal: await generatePayrollRules(ctx, body.prompt) });
    case "review":
      return json({ proposal: await reviewPolicy(ctx, body.policy) });
    case "activate":
      // Passed field by field: `z.unknown()` leaves the property optional in the
      // inferred type, and the service requires it to be present.
      return json(
        await activatePayrollRules(ctx, {
          policy: body.policy,
          effectiveFrom: body.effectiveFrom,
          note: body.note,
          aiPrompt: body.aiPrompt,
        }),
      );
  }
});
