import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { cancelRegularisation, decideRegularisation } from "@/services/attendance/regularisation";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), note: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().trim().max(300).optional() }),
  z.object({ action: z.literal("cancel") }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "approve":
      return json(await decideRegularisation(ctx, params.id, "APPROVED", body.note));
    case "reject":
      return json(await decideRegularisation(ctx, params.id, "REJECTED", body.note));
    case "cancel":
      return json(await cancelRegularisation(ctx, params.id));
  }
});
