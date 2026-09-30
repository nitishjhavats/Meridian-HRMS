import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { listImpersonationTargets } from "@/services/platform/organizations";

/**
 * Who the platform owner can sign in as, inside one organisation.
 *
 * Read-only and deliberately thin: names, emails, roles and employee codes for
 * accounts that already exist. It grants nothing — `POST /api/platform/impersonation`
 * is still the only thing that mints a session, and it still writes the reason
 * into that organisation's own audit log.
 *
 * Only people who *have* a login appear. An employee record is not an account,
 * and offering a control that cannot work is worse than saying so.
 */
export const GET = route<{ id: string }>(async (_request, { params }) => {
  const ctx = await requireContext();
  return json({ targets: await listImpersonationTargets(ctx, params.id) });
});
