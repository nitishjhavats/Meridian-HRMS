import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { suggestParameters, suggestWeights, writeCitation } from "@/services/ai/recognition";

/**
 * The three things the AI is allowed to do, and no fourth.
 *
 * A discriminated union rather than three endpoints, because the set is closed
 * on purpose: suggesting what to measure, saying what a split of the weights
 * rewards, and writing the citation once the arithmetic has decided. Choosing a
 * winner is not on this list and never will be.
 */
const bodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("parameters"), description: z.string().trim().min(15).max(2000) }),
  z.object({
    kind: z.literal("weights"),
    emphasis: z.string().trim().min(5).max(1000),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    month: z.coerce.number().int().min(1).max(12).optional(),
  }),
  z.object({
    kind: z.literal("citation"),
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(1).max(12),
    employeeId: z.string().min(1).optional(),
  }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);

  switch (body.kind) {
    case "parameters":
      return json(await suggestParameters(ctx, { description: body.description }));
    case "weights":
      return json(await suggestWeights(ctx, body));
    case "citation":
      return json(await writeCitation(ctx, body));
  }
});
