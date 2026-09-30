import { json, route } from "@/lib/http/handler";
import { listManageableUsers } from "@/services/org/permissions";

/**
 * The people whose permissions this caller may adjust.
 *
 * Deliberately not "everybody in the organisation": the service drops the
 * caller themselves, anybody at or above their own role, and office devices,
 * and returns a count of what it dropped so the screen can say why.
 */
export const GET = route(async (_request, { ctx }) => {
  return json(await listManageableUsers(ctx));
});
