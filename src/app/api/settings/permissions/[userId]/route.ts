import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { listUserPermissions, setUserPermission } from "@/services/org/permissions";

/**
 * One person's permissions, read and written one at a time.
 *
 * One permission per request rather than a whole set: a batch save on this
 * screen would mean the difference between two states, which is exactly the
 * shape that produces an audit row nobody can read afterwards. Each change is
 * its own decision, its own refusal, and its own line in the log.
 */
export const GET = route<{ userId: string }>(async (_request, { ctx, params }) => {
  return json(await listUserPermissions(ctx, params.userId));
});

const bodySchema = z.object({
  // Validated properly in the service, against the catalogue rather than a
  // duplicate of it here — a `platform.*` string is well-formed and still has
  // to be refused.
  permission: z.string().min(1).max(64),
  value: z.enum(["grant", "revoke", "inherit"]),
});

export const PUT = route<{ userId: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  const row = await setUserPermission(ctx, params.userId, body.permission, body.value);
  return json({ row });
});
