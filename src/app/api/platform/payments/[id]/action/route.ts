import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  approveOrder,
  issueConfirmationCode,
  rejectOrder,
  requestMoreInfo,
  revealIssuedCode,
} from "@/services/platform/payments";
import { withoutIssuedCode } from "@/services/billing/customerOrder";

/**
 * Every review decision on a payment goes through one endpoint, so the state
 * machine is the only thing that decides what is legal from here.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().max(500).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().min(1).max(500) }),
  z.object({ action: z.literal("request_info"), note: z.string().min(1).max(500) }),
  z.object({ action: z.literal("issue_code") }),
  z.object({ action: z.literal("reveal_code") }),
]);

export const POST = route<{ id: string }>(async (request, { params }) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);

  switch (body.action) {
    case "approve":
      return json({ order: withoutIssuedCode(await approveOrder(ctx, params.id, body.note)) });
    case "reject":
      return json({ order: withoutIssuedCode(await rejectOrder(ctx, params.id, body.note)) });
    case "request_info":
      return json({ order: withoutIssuedCode(await requestMoreInfo(ctx, params.id, body.note)) });
    case "issue_code": {
      const result = await issueConfirmationCode(ctx, params.id);
      // Returned once, to the platform owner, to pass on out of band.
      return json({ code: result.code, order: withoutIssuedCode(result.order) });
    }
    case "reveal_code":
      return json({ code: await revealIssuedCode(ctx, params.id) });
  }
});
