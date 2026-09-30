import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { draftLetter } from "@/services/ai/letters";

/**
 * AI drafting. Writes nothing but an audit row — the draft is returned for a
 * human to read, edit and then save.
 */
const schema = z.object({
  employeeId: z.string().min(1),
  category: z.string().min(1),
  prompt: z.string().trim().min(10).max(2000),
  context: z.string().trim().max(2000).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  return json({ draft: await draftLetter(ctx, body) });
});
