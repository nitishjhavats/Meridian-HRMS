import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { cancelLeave, decideLeave } from "@/services/leave";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("cancel") }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);

  switch (body.action) {
    case "approve":
      return json(await decideLeave(ctx, params.id, "APPROVED", body.note));
    case "reject":
      return json(await decideLeave(ctx, params.id, "REJECTED", body.note));
    case "cancel":
      return json(await cancelLeave(ctx, params.id));
  }
});
