import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { addChecklistItem, setChecklistItem } from "@/services/exit";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    itemId: z.string().min(1),
    status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "SKIPPED"]),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({ action: z.literal("add"), title: z.string().trim().min(2).max(200) }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  return body.action === "add"
    ? json(await addChecklistItem(ctx, params.id, body.title), { status: 201 })
    : json(await setChecklistItem(ctx, body.itemId, body.status, body.note));
});
