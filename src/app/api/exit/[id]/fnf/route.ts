import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { calculateFnf, previewFnf } from "@/services/exit/fnf";

/** GET previews without saving; POST persists the calculation. */
export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ preview: await previewFnf(ctx, params.id) });
});

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  await parseBody(request, z.object({ action: z.literal("calculate") }));
  return json(await calculateFnf(ctx, params.id));
});
