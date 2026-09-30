import { z } from "zod";
import { json, parseQuery, route } from "@/lib/http/handler";
import { previewCycle } from "@/services/recognition";

const periodSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

/** The draft ranking with every figure in it. Computes; writes nothing. */
export const GET = route(async (request, { ctx }) => {
  const { year, month } = parseQuery(request, periodSchema);
  return json(await previewCycle(ctx, year, month));
});
