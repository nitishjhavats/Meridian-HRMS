import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { addComment, deleteComment, listComments } from "@/services/announcements";

export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ comments: await listComments(ctx, params.id) });
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    body: z.string().trim().min(1).max(2000),
    parentId: z.string().optional(),
  }),
  z.object({ action: z.literal("delete"), commentId: z.string().min(1) }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  if (body.action === "delete") return json(await deleteComment(ctx, body.commentId));
  return json(await addComment(ctx, params.id, body.body, body.parentId), { status: 201 });
});
