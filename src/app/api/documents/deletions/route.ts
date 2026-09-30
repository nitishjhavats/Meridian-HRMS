import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { decideDeletion, listDeletionRequests } from "@/services/documents";

export const GET = route(async (_request, { ctx }) => {
  return json({ requests: await listDeletionRequests(ctx) });
});

const schema = z.object({
  requestId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().trim().max(500).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  return json(await decideDeletion(ctx, body.requestId, body.decision, body.note));
});
