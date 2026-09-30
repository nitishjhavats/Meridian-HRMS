import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { previewFramework } from "@/services/letters/templates";

const bodySchema = z.object({
  employeeId: z.string().optional(),
  /** Values typed into the fill-in form, which win over what the record says. */
  overrides: z.record(z.string(), z.string()).optional(),
});

export const POST = route<{ category: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  return json(await previewFramework(ctx, params.category, body));
});
