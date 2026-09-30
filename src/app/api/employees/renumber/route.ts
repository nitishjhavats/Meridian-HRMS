import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { previewRenumber, renumberEmployees } from "@/services/employees/renumber";

/**
 * Move a whole directory onto the organisation's own code prefix.
 *
 * GET is the preview and writes nothing; POST applies exactly the plan the
 * preview described, and refuses when the directory has moved since.
 */

const querySchema = z.object({
  prefix: z.string().trim().max(8).optional(),
});

const bodySchema = z.object({
  prefix: z.string().trim().max(8).optional(),
  /** What the preview said would change. A mismatch means look again. */
  expectedChanging: z.number().int().min(0).max(100_000),
});

export const GET = route(async (request, { ctx }) => {
  const { prefix } = parseQuery(request, querySchema);
  return json({ plan: await previewRenumber(ctx, prefix) });
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);
  return json(await renumberEmployees(ctx, body));
});
