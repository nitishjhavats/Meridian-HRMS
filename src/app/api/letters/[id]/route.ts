import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { deleteDraft, getLetter, issueLetter, revokeLetter, updateLetter } from "@/services/letters";

export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ letter: await getLetter(ctx, params.id) });
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    subject: z.string().trim().min(2).max(200).optional(),
    body: z.string().min(10).max(50_000).optional(),
    filled: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    action: z.literal("issue"),
    subject: z.string().trim().min(2).max(200).optional(),
    body: z.string().min(10).max(50_000).optional(),
    filled: z.record(z.string(), z.string()).optional(),
  }),
  z.object({ action: z.literal("revoke"), reason: z.string().trim().max(500).optional() }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "save":
      return json(await updateLetter(ctx, params.id, body));
    case "issue":
      // Save first when the browser sent edits with it. "Save and issue" as two
      // requests can half-succeed, and a letter issued from a body the second
      // request never wrote is the wrong document with the right reference.
      if (body.subject !== undefined || body.body !== undefined || body.filled !== undefined) {
        await updateLetter(ctx, params.id, body);
      }
      return json(await issueLetter(ctx, params.id));
    case "revoke":
      return json(await revokeLetter(ctx, params.id, body.reason));
  }
});

export const DELETE = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await deleteDraft(ctx, params.id));
});
