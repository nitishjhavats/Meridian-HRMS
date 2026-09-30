import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseQuery, route } from "@/lib/http/handler";
import { listOrders } from "@/services/platform/payments";

const querySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((v) => (v ? (v.split(",") as never[]) : undefined)),
  organizationId: z.string().optional(),
  search: z.string().optional(),
  couponCode: z.string().optional(),
  take: z.coerce.number().int().min(1).max(200).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});

export const GET = route(async (request) => {
  const ctx = await requireContext();
  const filters = parseQuery(request, querySchema);
  return json(await listOrders(ctx, filters));
});
