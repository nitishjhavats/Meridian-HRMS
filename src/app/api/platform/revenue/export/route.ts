import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { csvResponse, parseQuery, route } from "@/lib/http/handler";
import { getPaymentHistory, paymentHistoryToCsv } from "@/services/platform/analytics";

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  organizationId: z.string().optional(),
  couponCode: z.string().optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",") : undefined)),
});

export const GET = route(async (request) => {
  const ctx = await requireContext();
  const filters = parseQuery(request, querySchema);
  const rows = await getPaymentHistory(ctx, filters, 5_000);
  const stamp = new Date().toISOString().slice(0, 10);
  return csvResponse(`hrms-payments-${stamp}.csv`, paymentHistoryToCsv(rows));
});
