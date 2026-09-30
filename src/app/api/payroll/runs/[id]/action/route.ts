import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { approveRun, calculateRun, lockRun, reopenRun } from "@/services/payroll/runs";

/**
 * Every state change on a run goes through one endpoint, so the lifecycle rules
 * live in the service and nowhere else.
 */
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("calculate") }),
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("lock") }),
  z.object({ action: z.literal("reopen"), reason: z.string().trim().min(1).max(500) }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);

  switch (body.action) {
    case "calculate":
      return json({ report: await calculateRun(ctx, params.id) });
    case "approve":
      return json({ run: await approveRun(ctx, params.id) });
    case "lock":
      return json({ run: await lockRun(ctx, params.id) });
    case "reopen":
      // Creates a new revision; the locked run is left exactly as it was paid.
      return json({ run: await reopenRun(ctx, params.id, body.reason) });
  }
});
