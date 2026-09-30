import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { joinEmployeeDirectory, saveMyProfile } from "@/services/account/profile";

/**
 * Your own name and designation.
 *
 * There is no id in either handler. The service reads `ctx.userId` and nothing
 * else, so this route cannot be pointed at somebody else's record however it is
 * called.
 */

const schema = z.object({
  name: z.string().min(2).max(120),
  designationId: z.string().min(1).nullable(),
});

export const PUT = route(async (request, { ctx }) => {
  return json({ profile: await saveMyProfile(ctx, await parseBody(request, schema)) });
});

/** Creates the employee record an owner of an older organisation never got. */
export const POST = route(async (_request, { ctx }) => {
  return json({ profile: await joinEmployeeDirectory(ctx) });
});
