import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { releaseOtp } from "@/services/auth/passwordReset";

/**
 * Reveals the one-time code to the platform owner and marks the request
 * released. This is the only path by which the plaintext leaves the database,
 * and every call is audited — including a re-read of a code already shown.
 */
export const POST = route<{ id: string }>(async (_request, { params }) => {
  const ctx = await requireContext();
  return json({ code: await releaseOtp(ctx, params.id) });
});
