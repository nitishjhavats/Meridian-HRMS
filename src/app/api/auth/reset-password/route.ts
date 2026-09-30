import { z } from "zod";
import { json, parseBody, publicRoute, requestMeta } from "@/lib/http/handler";
import { completePasswordReset } from "@/services/auth/passwordReset";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  otp: z.string().trim().min(4).max(12),
  newPassword: z.string().min(1),
});

export const POST = publicRoute(async (request) => {
  const body = await parseBody(request, bodySchema);
  const meta = requestMeta(request);
  await completePasswordReset({ ...body, ipAddress: meta.ipAddress });
  return json({ ok: true });
});
