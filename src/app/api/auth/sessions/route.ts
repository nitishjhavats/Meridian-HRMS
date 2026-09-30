import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  listLoginHistory,
  listSessions,
  revokeOtherSessions,
  revokeSession,
} from "@/services/auth/sessions";

export const GET = route(async (_request, { ctx }) => {
  const [sessions, history] = await Promise.all([listSessions(ctx), listLoginHistory(ctx)]);
  return json({ sessions, history });
});

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("revoke"), sessionId: z.string().min(1) }),
  z.object({ action: z.literal("revoke-others") }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  return body.action === "revoke"
    ? json(await revokeSession(ctx, body.sessionId))
    : json(await revokeOtherSessions(ctx));
});
