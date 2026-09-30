import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { whoCanIssuePin } from "@/services/attendance/pinAuthority";

/**
 * Who to ask for a PIN, for the dialog somebody sees when their face fails.
 *
 * Readable by any signed-in member of the organisation, deliberately: a list of
 * who to go to for help is useless if it is a secret, and it carries only names
 * and designations — the same two facts the employee directory already shows
 * everybody.
 */
export const GET = route(async () => {
  const ctx = await requireContext();
  return json({ people: await whoCanIssuePin(ctx) });
});
