import { optionalContext } from "@/lib/auth/context";
import { json, publicRoute } from "@/lib/http/handler";

/**
 * The signed-in user, for client components that need it.
 *
 * Only non-sensitive fields are returned. Permissions are included because the
 * UI uses them to decide what to render — but every one of them is re-checked
 * server-side on the actual request, so a tampered client gains nothing.
 */
export const GET = publicRoute(async () => {
  const ctx = await optionalContext();
  if (!ctx) return json({ authenticated: false });

  return json({
    authenticated: true,
    user: {
      id: ctx.userId,
      name: ctx.name,
      email: ctx.email,
      role: ctx.role,
      employeeId: ctx.employeeId,
    },
    organization: ctx.organization,
    permissions: [...ctx.permissions],
    modules: [...ctx.modules],
    accessState: ctx.accessState,
    readOnlyView: ctx.readOnlyView,
    impersonatedBy: ctx.impersonating?.byEmail ?? null,
  });
});
