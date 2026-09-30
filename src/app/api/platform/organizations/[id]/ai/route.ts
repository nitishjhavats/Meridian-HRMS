import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { getOrgAi, setOrgAi } from "@/services/platform/orgAi";

export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await getOrgAi(ctx, params.id));
});

/**
 * The key is accepted here and never returned. `apiKey: ""` clears it;
 * omitting the field leaves whatever is there alone.
 */
const bodySchema = z.object({
  apiKey: z.string().max(400).optional(),
  orgMayManageKey: z.boolean().optional(),
  model: z.string().trim().max(120).optional(),
  monthlyTokenCap: z.number().int().min(0).max(100_000_000).nullable().optional(),
});

export const PATCH = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  return json(await setOrgAi(ctx, params.id, body));
});
