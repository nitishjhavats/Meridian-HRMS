import { requireContext } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { keyBelongsTo, storage } from "@/lib/storage";
import { route } from "@/lib/http/handler";

/**
 * Authorised file access.
 *
 * Nothing in storage is public. Every read goes through a session check and a
 * tenant check, so a leaked key is useless to someone outside the organisation
 * it belongs to — which matters most for the two kinds of file here: employee
 * documents and attendance selfies.
 */
export const GET = route<{ key: string[] }>(async (_request, { ctx, params }) => {
  const key = params.key.join("/");

  // The platform owner may read platform-scoped files; everyone else is confined
  // to their own organisation's prefix.
  if (!keyBelongsTo(key, ctx.isSuperadmin ? null : ctx.organizationId)) {
    throw new NotFoundError("That file");
  }

  const file = await storage().get(key);
  if (!file) throw new NotFoundError("That file");

  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.data.length),
      // Private: a shared cache must never hold somebody's payslip or selfie.
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
