import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { reviewEvent } from "@/services/attendance/review";

const bodySchema = z.object({
  verdict: z.enum(["VERIFIED", "REJECTED"]),
  note: z.string().trim().max(500).optional(),
});

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  return json(await reviewEvent(ctx, params.id, body));
});
