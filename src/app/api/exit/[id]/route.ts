import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { cancelExit, getExit, setExitStatus } from "@/services/exit";

export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ exit: await getExit(ctx, params.id) });
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status"),
    status: z.enum(["INITIATED", "NOTICE_PERIOD", "CLEARANCE", "SETTLED"]),
    note: z.string().trim().max(2000).optional(),
  }),
  z.object({ action: z.literal("cancel"), reason: z.string().trim().max(500).optional() }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  return body.action === "cancel"
    ? json(await cancelExit(ctx, params.id, body.reason))
    : json(await setExitStatus(ctx, params.id, body.status, body.note));
});
