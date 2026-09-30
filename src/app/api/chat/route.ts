import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import {
  MAX_MESSAGE_LENGTH,
  getConversation,
  listContacts,
  sendMessage,
} from "@/services/chat";

/**
 * The chat list, one conversation, and sending.
 *
 * There is no DELETE here, and there is not going to be one. See the note at
 * the top of `services/chat/index.ts`.
 */

const querySchema = z.object({
  /** Omit for the contact list; give an employee id for one conversation. */
  with: z.string().optional(),
  /** Only messages after this id — what the open-thread poll sends. */
  after: z.string().optional(),
});

export const GET = route(async (request, { ctx }) => {
  const { with: other, after } = parseQuery(request, querySchema);
  if (!other) return json({ contacts: await listContacts(ctx) });
  return json({ conversation: await getConversation(ctx, other, { after }) });
});

const sendSchema = z.object({
  toEmployeeId: z.string(),
  body: z.string().min(1).max(MAX_MESSAGE_LENGTH),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, sendSchema);
  return json(await sendMessage(ctx, body));
});
