import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { rejectResetRequest } from "@/services/auth/passwordReset";

const bodySchema = z.object({ reason: z.string().trim().min(1).max(500) });

export const POST = route<{ id: string }>(async (request, { params }) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);
  await rejectResetRequest(ctx, params.id, body.reason);
  return json({ ok: true });
});
