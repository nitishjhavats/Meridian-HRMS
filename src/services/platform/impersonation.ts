import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { landingFor } from "@/lib/auth/landing";
import {
  clearImpersonationCookie,
  setImpersonationCookie,
  signImpersonation,
} from "@/lib/auth/impersonation";
import { writeAudit } from "@/lib/audit";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";

/**
 * Starting and stopping a support visit.
 *
 * The platform owner acts as somebody inside a customer's organisation and can
 * change things while they are there. That is the whole value — a support visit
 * that can only look cannot fix a misconfigured payroll rule — and it is why
 * every guard here is about *who* may be acted as and *what the record says*
 * afterwards, rather than about narrowing what is possible once inside.
 */

export interface StartImpersonationInput {
  userId: string;
  reason: string;
  /** Look, do not touch. Off by default. */
  readOnly?: boolean;
}

export async function startImpersonation(ctx: AuthContext, input: StartImpersonationInput) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.read");

  // Nesting one visit inside another would make the audit trail unreadable —
  // which of the two superadmins is "the" actor? — and there is no reason to.
  if (ctx.impersonating) {
    throw new ValidationError("Stop the current support session before starting another.");
  }

  const reason = input.reason.trim();
  if (reason.length < 4) {
    throw new ValidationError("Say why you are signing in as them. It is written to their log.");
  }

  const target = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      organizationId: true,
      organization: { select: { id: true, name: true, slug: true, status: true } },
    },
  });
  if (!target) throw new NotFoundError("That account");

  if (!target.organizationId || !target.organization) {
    throw new ValidationError("That account does not belong to an organisation.");
  }
  if (target.role === "SUPERADMIN") {
    throw new ForbiddenError("One platform owner cannot act as another.");
  }
  /**
   * An office device may be acted as, and only to look.
   *
   * The refusal here was right about the risk and wrong about the remedy. A
   * kiosk's security rests on there being no person behind it, so borrowing its
   * identity to *mark attendance* would be exactly the fraud the face check
   * exists to stop -- but "why does the reception screen show nobody" is a real
   * support question, and answering it meant asking somebody in that office to
   * describe their screen down a phone.
   *
   * So it is allowed and forced read-only, whatever the caller asked for. A
   * read-only session cannot write, which means it cannot mark attendance,
   * which was the whole objection.
   */
  const readOnly = input.readOnly === true || target.role === "KIOSK";
  if (target.status !== "ACTIVE") {
    throw new ValidationError(`That account is ${target.status.toLowerCase()}.`);
  }

  const { token, expiresAt } = await signImpersonation({
    target: target.id,
    org: target.organizationId,
    reason,
    readOnly,
    // The visit belongs to this sign-in and no other. See `ImpersonationClaims`.
    bySession: ctx.sessionId,
  });
  await setImpersonationCookie(token, expiresAt);

  // Written against the customer's organisation, so it appears in *their* audit
  // log and not only in the platform's. Being visited is something they are
  // entitled to see.
  await writeAudit(ctx, {
    action: "platform.impersonation_started",
    entityType: "User",
    entityId: target.id,
    organizationId: target.organizationId,
    metadata: {
      targetEmail: target.email,
      targetRole: target.role,
      organization: target.organization.name,
      reason,
      readOnly,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return {
    // A device lands on its own screen. `/o/<slug>` is a sign-in page, and a
    // kiosk session arriving there would bounce through the app shell, which
    // sends it to `/kiosk` anyway -- one redirect the support engineer would
    // have watched happen for no reason.
    redirectTo: target.role === "KIOSK" ? "/kiosk" : `/o/${target.organization.slug}`,
    landing: landingFor(target.role),
    target: { name: target.name, email: target.email },
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * End it.
 *
 * `ctx` here is the *target's* context, because that is what impersonation
 * produces — so the superadmin is read off `ctx.impersonating` rather than off
 * the actor, and the row is written the same way round as every other one made
 * during the visit.
 */
export async function stopImpersonation(ctx: AuthContext) {
  if (!ctx.impersonating) {
    await clearImpersonationCookie();
    return { redirectTo: "/platform" };
  }

  await writeAudit(ctx, {
    action: "platform.impersonation_ended",
    entityType: "User",
    entityId: ctx.userId,
    organizationId: ctx.organizationId,
    metadata: { targetEmail: ctx.email },
  });

  await clearImpersonationCookie();
  return { redirectTo: "/platform" };
}
