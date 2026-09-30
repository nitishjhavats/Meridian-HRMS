import { z } from "zod";
import { json, parseBody, publicRoute, requestMeta } from "@/lib/http/handler";
import { requestPasswordReset } from "@/services/auth/passwordReset";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
});

/**
 * The response is identical whether or not the account exists — otherwise this
 * endpoint becomes a way to discover who works where. The OTP is never in the
 * response; it appears only in the Superadmin console.
 */
export const POST = publicRoute(async (request) => {
  const body = await parseBody(request, bodySchema);
  const meta = requestMeta(request);
  const result = await requestPasswordReset({ email: body.email, ...meta });
  return json(result);
});
