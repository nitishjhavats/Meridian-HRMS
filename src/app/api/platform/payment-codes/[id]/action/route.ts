import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { revealAdvanceCode, revokeAdvanceCode } from "@/services/platform/payments";

/** The two things the owner can do to a code they made: read it again, or take it back. */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reveal") }),
  z.object({ action: z.literal("revoke") }),
]);

export const POST = route<{ id: string }>(async (request, { params }) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);

  switch (body.action) {
    case "reveal":
      return json({ code: await revealAdvanceCode(ctx, params.id) });
    case "revoke":
      return json({ code: await revokeAdvanceCode(ctx, params.id) });
  }
});
