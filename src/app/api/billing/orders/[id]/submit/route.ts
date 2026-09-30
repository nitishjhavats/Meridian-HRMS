import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  submitBoundCode,
  submitConfirmationCode,
  submitNothingToPay,
  submitReference,
} from "@/services/billing/orders";

/**
 * "I have paid." Which half of the handshake this is depends on the platform's
 * confirmation mode: either the organisation supplies its own UTR, or it enters
 * the code the platform owner issued.
 */
const bodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("reference"),
    reference: z.string().trim().min(3).max(64),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({ mode: z.literal("code"), code: z.string().trim().min(4).max(12) }),
  // Nothing to enter, because there is nothing to pay. Whether that is true is
  // checked in the service against the order, never trusted from here.
  z.object({ mode: z.literal("nothing-due") }),
  // The code was applied at checkout and is bound to the order already; the
  // button is the confirmation, and the digits are not asked for twice.
  z.object({ mode: z.literal("bound-code") }),
]);

export const POST = route<{ id: string }>(async (request, { params }) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);

  const order =
    body.mode === "reference"
      ? await submitReference(ctx, params.id, { reference: body.reference, note: body.note })
      : body.mode === "code"
        ? await submitConfirmationCode(ctx, params.id, body.code)
        : body.mode === "bound-code"
          ? await submitBoundCode(ctx, params.id)
          : await submitNothingToPay(ctx, params.id);

  return json({ order });
});
