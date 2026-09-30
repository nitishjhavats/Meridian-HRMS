import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { deleteAnnouncement, updateAnnouncement } from "@/services/announcements";

const patchSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  body: z.string().trim().min(3).max(20_000).optional(),
  pinned: z.boolean().optional(),
  published: z.boolean().optional(),
  commentsEnabled: z.boolean().optional(),
  publishAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const PATCH = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, patchSchema);
  return json(await updateAnnouncement(ctx, params.id, body));
});

export const DELETE = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await deleteAnnouncement(ctx, params.id));
});
