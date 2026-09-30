import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { customiseTemplate } from "@/services/ai/letters";

const bodySchema = z.object({
  part: z.enum(["header", "body", "footer"]),
  current: z.string().max(20_000),
  instruction: z.string().trim().min(4).max(600),
});

/**
 * Ask for a change in words. Returns the edited text and saves nothing — the
 * administrator previews it and then saves deliberately.
 */
export const POST = route<{ category: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  return json(await customiseTemplate(ctx, { ...body, category: params.category }));
});
