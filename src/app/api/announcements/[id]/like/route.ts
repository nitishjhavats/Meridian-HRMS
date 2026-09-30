import { json, route } from "@/lib/http/handler";
import { toggleLike } from "@/services/announcements";

export const POST = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await toggleLike(ctx, params.id));
});
