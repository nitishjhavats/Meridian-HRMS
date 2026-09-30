import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { startImpersonation, stopImpersonation } from "@/services/platform/impersonation";

const bodySchema = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().min(4).max(200),
  readOnly: z.boolean().optional(),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  return json(await startImpersonation(ctx, await parseBody(request, bodySchema)));
});

/** Ending a visit needs no body and no permission beyond being in one. */
export const DELETE = route(async () => {
  const ctx = await requireContext();
  return json(await stopImpersonation(ctx));
});
