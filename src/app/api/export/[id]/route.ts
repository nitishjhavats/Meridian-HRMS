import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { downloadExport, revealPassword } from "@/services/export";

/**
 * Unlocking an export.
 *
 * A POST rather than a GET because the password has to travel in a body: in a
 * query string it would end up in browser history, in a proxy log, and in the
 * referrer of the next page.
 */
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reveal") }),
  z.object({ action: z.literal("download"), password: z.string().min(1) }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);

  if (body.action === "reveal") {
    return json({ password: await revealPassword(ctx, params.id) });
  }

  const file = await downloadExport(ctx, params.id, body.password);
  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(file.data.length),
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      // Never cached anywhere: this is the whole organisation, decrypted.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
