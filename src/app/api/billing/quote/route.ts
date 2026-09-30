import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { quoteOrder } from "@/services/billing/orders";

const bodySchema = z.object({
  userCount: z.number().int().min(1).max(10_000),
  periodMonths: z.number().int().min(1).max(36).optional(),
  couponCode: z.string().trim().max(32).nullable().optional(),
});

/** Live pricing for the seat selector. No writes, so it is safe to call often. */
export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);
  return json(await quoteOrder(ctx, body));
});
