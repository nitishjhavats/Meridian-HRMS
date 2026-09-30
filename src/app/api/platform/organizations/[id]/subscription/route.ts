import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { updateSubscription } from "@/services/platform/organizations";

/**
 * Commercials after the fact.
 *
 * The expiry is set as a date rather than derived from the cycle: the cycle says
 * how long a renewal runs, and this says when the current licence ends. An
 * organisation that paid late has a period that does not line up with its cycle,
 * and computing one from the other would either cut them off early or hand them
 * a free month.
 */
const bodySchema = z.object({
  seats: z.number().int().min(0).max(10_000).optional(),
  billingMode: z.enum(["TRIAL", "PAID", "FREE_INTERNAL"]).optional(),
  billingCycle: z.enum(["MONTHLY", "QUARTERLY", "HALF_YEARLY", "ANNUAL"]).optional(),
  currentPeriodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  active: z.boolean().optional(),
});

export const PATCH = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  return json({ subscription: await updateSubscription(ctx, params.id, body) });
});
