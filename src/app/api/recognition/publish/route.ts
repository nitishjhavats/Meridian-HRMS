import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { publishCycle } from "@/services/recognition";

const publishSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  /** Somebody other than the top score. The service insists on a reason for that. */
  winnerEmployeeId: z.string().min(1).optional(),
  overrideReason: z.string().trim().max(600).optional(),
  citation: z.string().trim().max(2000).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, publishSchema);
  return json(await publishCycle(ctx, body));
});
