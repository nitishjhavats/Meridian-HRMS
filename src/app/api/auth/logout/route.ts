import { writeAudit } from "@/lib/audit";
import { optionalContext } from "@/lib/auth/context";
import { clearImpersonationCookie } from "@/lib/auth/impersonation";
import { clearSessionCookie, revokeSession } from "@/lib/auth/session";
import { json, publicRoute, requestMeta } from "@/lib/http/handler";

/**
 * Sign out. Revokes the session row as well as clearing the cookie — a cookie
 * cleared client-side alone would leave a still-valid token in anyone's hands
 * who had copied it.
 *
 * Signing out *during* a support visit is a different act, and treating the two
 * the same was a real defect. While impersonating, `ctx` is the person being
 * acted as: `ctx.userId` is theirs, while `ctx.sessionId` is still the
 * superadmin's. So signing out of a reception screen revoked the superadmin's
 * own session and wrote the kiosk device down as having revoked it. It also
 * left `hrms_impersonation` in the browser, which is what then met the next
 * sign-in and sent them back to the kiosk.
 *
 * Ending a visit therefore ends the visit and nothing else. The superadmin
 * stays signed in as themselves, which is where they wanted to be.
 */
export const POST = publicRoute(async (request) => {
  const ctx = await optionalContext();

  if (ctx?.impersonating) {
    await clearImpersonationCookie();
    await writeAudit(ctx, {
      action: "platform.impersonation_ended",
      entityType: "User",
      entityId: ctx.userId,
      organizationId: ctx.organizationId ?? undefined,
      metadata: { via: "sign-out", by: ctx.impersonating.byEmail },
      ...requestMeta(request),
    });
    return json({ ok: true, endedImpersonation: true, redirectTo: "/platform" });
  }

  if (ctx) {
    await revokeSession(ctx.sessionId, ctx.userId);
    await writeAudit(ctx, {
      action: "auth.logout",
      entityType: "User",
      entityId: ctx.userId,
      ...requestMeta(request),
    });
  }

  // Belt and braces under the session binding in `ImpersonationClaims`: a
  // cookie left behind here is already inert, and it should not be left behind.
  await clearImpersonationCookie();
  await clearSessionCookie();
  return json({ ok: true, endedImpersonation: false, redirectTo: "/login" });
});
