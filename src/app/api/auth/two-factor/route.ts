import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  beginEnrolment,
  confirmEnrolment,
  disableTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
} from "@/services/auth/twoFactor";

export const GET = route(async (_request, { ctx }) => {
  return json(await getTwoFactorStatus(ctx));
});

/**
 * Enrolment is two steps: `begin` mints a secret, `confirm` proves a code from
 * it works and only then switches 2FA on. Turning it off, and reissuing
 * recovery codes, both need the password — a borrowed session must not be
 * enough to remove the protection.
 */
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin") }),
  z.object({ action: z.literal("confirm"), code: z.string().trim().min(6).max(10) }),
  z.object({ action: z.literal("disable"), password: z.string().min(1) }),
  z.object({ action: z.literal("regenerate-codes"), password: z.string().min(1) }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "begin":
      return json(await beginEnrolment(ctx));
    case "confirm":
      return json(await confirmEnrolment(ctx, body.code));
    case "disable":
      return json(await disableTwoFactor(ctx, body.password));
    case "regenerate-codes":
      return json(await regenerateRecoveryCodes(ctx, body.password));
  }
});
