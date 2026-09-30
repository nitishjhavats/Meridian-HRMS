import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { created, json, parseBody, route } from "@/lib/http/handler";
import { createOrder, listOrdersForOrg } from "@/services/billing/orders";

export const GET = route(async () => {
  const ctx = await requireContext();
  return json({ orders: await listOrdersForOrg(ctx) });
});

const bodySchema = z.object({
  userCount: z.number().int().min(1).max(10_000),
  periodMonths: z.number().int().min(1).max(36).optional(),
  couponCode: z.string().trim().max(32).nullable().optional(),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);
  return created({ order: await createOrder(ctx, body) });
});
