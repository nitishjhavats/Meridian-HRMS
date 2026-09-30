import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  listCarryForwardRuns,
  redoCarryForward,
  runCarryForward,
  undoCarryForward,
} from "@/services/leave/balances";

/**
 * The year-end run.
 *
 * One endpoint for both halves of preview → confirm, because they are the same
 * computation: `commit: false` works out what would happen and writes nothing.
 * A separate "preview" endpoint would be a second description of the run that
 * could drift from the run itself, and the whole point of the confirm step is
 * that the number on the button is the number that lands.
 */

const bodySchema = z.union([
  z.object({
    fromYear: z.number().int().min(2000).max(2100),
    toYear: z.number().int().min(2000).max(2100),
    commit: z.boolean().optional(),
  }),
  // Taking a run back, or putting it back again. On the same route because it
  // is the same act seen from the other end, and because the screen that runs
  // one is the screen that reverses it.
  z.object({ runId: z.string().min(1), direction: z.enum(["UNDO", "REDO"]) }),
]);

export const GET = route(async (_request, { ctx }) => {
  return json({ runs: await listCarryForwardRuns(ctx) });
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);
  if ("runId" in body) {
    const result =
      body.direction === "UNDO"
        ? await undoCarryForward(ctx, body.runId)
        : await redoCarryForward(ctx, body.runId);
    return json({ ...result, runs: await listCarryForwardRuns(ctx) });
  }
  return json(await runCarryForward(ctx, body));
});
