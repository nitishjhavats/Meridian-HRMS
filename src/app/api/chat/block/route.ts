import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { reportConversation, setBlocked } from "@/services/chat";

/**
 * Blocking and reporting.
 *
 * A block is silent to the person blocked, so nothing here notifies them and
 * nothing writes their name into something they can read. A report is the
 * opposite: it goes straight to HR and the administrators.
 */

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("block"),
    employeeId: z.string(),
    blocked: z.boolean(),
  }),
  z.object({
    action: z.literal("report"),
    employeeId: z.string(),
    reason: z.string().trim().min(10).max(1000),
  }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);
  if (body.action === "block") {
    return json(await setBlocked(ctx, body.employeeId, body.blocked));
  }
  return json(
    await reportConversation(ctx, { otherEmployeeId: body.employeeId, reason: body.reason }),
  );
});
