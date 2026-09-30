import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { closeAdvance } from "@/services/payroll/advances";

const bodySchema = z.object({
  status: z.enum(["CANCELLED", "WRITTEN_OFF"]),
  reason: z.string().trim().min(4).max(200),
});

/** Closing an advance early — cancelled by mistake, or written off deliberately. */
export const PATCH = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  return json({ advance: await closeAdvance(ctx, params.id, body.status, body.reason) });
});
