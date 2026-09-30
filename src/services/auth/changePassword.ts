import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { checkPassword, hashPassword, verifyPassword } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";

/**
 * Changing your own password, knowing the old one.
 *
 * The product shipped without this. `LoginForm` sent anybody carrying
 * `mustChangePassword` to `/change-password`, a route that did not exist — so
 * every organisation Broadmate onboarded met a 404 on their very first sign-in,
 * and the only way out was the superadmin-released reset code. That is the
 * emergency path, not the ordinary one.
 *
 * Two decisions worth stating:
 *
 * **The old password is required, always** — even when `mustChangePassword` is
 * set. A session cookie is not proof of the person; a borrowed laptop is.
 *
 * **Every other session is revoked.** `completePasswordReset` already does this
 * for the reset path, and the reasoning is identical: somebody changing their
 * password may be doing it precisely because someone else has it.
 */

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export async function changeOwnPassword(
  ctx: AuthContext,
  input: ChangePasswordInput,
): Promise<{ otherSessionsSignedOut: number }> {
  // A support visit does not include choosing somebody's password. Knowing the
  // old one is the proof this whole function rests on, and a platform owner
  // acting as them does not have it.
  if (ctx.impersonating) {
    throw new ValidationError(
      "You are acting as somebody else. Their password is theirs to change.",
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { id: true, passwordHash: true, organizationId: true },
  });
  if (!user) throw new ValidationError("That account no longer exists.");

  const ok = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!ok) throw new ValidationError("Your current password is not right.");

  if (input.currentPassword === input.newPassword) {
    throw new ValidationError("The new password has to be different from the old one.");
  }

  const strength = checkPassword(input.newPassword);
  if (!strength.ok) throw new ValidationError(strength.problems.join(" "));

  const passwordHash = await hashPassword(input.newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  // Keep the session doing the changing; end every other one.
  const otherSessionsSignedOut = await revokeAllSessions(user.id, {
    exceptSessionId: ctx.sessionId,
    revokedById: user.id,
  });

  await writeAudit(ctx, {
    action: "auth.password_changed",
    entityType: "User",
    entityId: user.id,
    metadata: { otherSessionsSignedOut },
  });

  return { otherSessionsSignedOut };
}
