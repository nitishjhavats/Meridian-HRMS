import { prisma } from "@/lib/db/prisma";
import { signInUrl } from "@/services/employees/credentials";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { writeAnonymousAudit, writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { enforce } from "@/lib/ratelimit";
import { decryptOptional, encryptField } from "@/lib/crypto/field";
import { checkPassword, generateOtp, hashPassword, verifyCode } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";

/**
 * Admin password reset, released by the platform owner.
 *
 * The requirement is unusual and worth restating: the OTP must **not** reach the
 * person asking for it. It is generated server-side, hashed for verification and
 * encrypted for display, and it appears only inside the Superadmin console. The
 * owner then passes it on out of band, having satisfied themselves the request
 * is genuine.
 *
 * Consequences that shape this code:
 *   - the request endpoint returns the same answer whether or not the account
 *     exists, so it cannot be used to discover who works where;
 *   - the plaintext is never in an audit row, a notification or a response body;
 *   - the code is one-time-use, expiring, and attempt-limited;
 *   - a successful reset revokes every existing session for that user.
 */

/** Roles whose reset goes through the Superadmin. Everyone else asks their HR/Admin. */
export const SUPERADMIN_RELEASED_ROLES = ["ORG_OWNER", "ADMIN"] as const;

export interface ResetRequestResult {
  /** Always the same, whatever happened, so nothing can be inferred. */
  message: string;
  requiresSuperadminRelease: boolean;
}

export const GENERIC_MESSAGE =
  "If that account exists, a password reset request has been raised. Your administrator will share the verification code with you.";

/**
 * Which of the accounts on that address get a code minted.
 *
 * A suspended account, and a role that resets through its own HR team, are both
 * "no code" — and so is an address nobody uses. The rule is named here because
 * what matters about those three cases is that the caller cannot tell them
 * apart: the answer below is the same either way.
 */
export function eligibleForSuperadminRelease<T extends { status: string; role: string }>(
  users: readonly T[],
): T[] {
  return users.filter(
    (u) => u.status === "ACTIVE" && SUPERADMIN_RELEASED_ROLES.includes(u.role as never),
  );
}

export async function requestPasswordReset(input: {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<ResetRequestResult> {
  const email = input.email.trim().toLowerCase();
  await enforce("passwordReset", `email:${email}`);
  if (input.ipAddress) await enforce("passwordReset", `ip:${input.ipAddress}`);

  const users = await prisma.user.findMany({
    where: { email },
    take: 5,
    select: { id: true, email: true, name: true, role: true, status: true, organizationId: true },
  });

  const eligible = eligibleForSuperadminRelease(users);

  await writeAnonymousAudit({
    action: "auth.password_reset_requested",
    entityType: "User",
    entityId: eligible[0]?.id ?? null,
    actorEmail: email,
    organizationId: eligible[0]?.organizationId ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    metadata: { matched: eligible.length },
  });

  for (const user of eligible) {
    const settings = await prisma.platformSetting.findUnique({ where: { id: "singleton" } });
    const ttlMinutes = settings?.otpTtlMinutes ?? 15;

    // Any earlier pending request is superseded, so only one code is ever live.
    await prisma.passwordResetRequest.updateMany({
      where: { userId: user.id, status: { in: ["PENDING", "RELEASED"] } },
      data: { status: "EXPIRED" },
    });

    const otp = await generateOtp();

    await prisma.passwordResetRequest.create({
      data: {
        userId: user.id,
        organizationId: user.organizationId,
        requestedEmail: email,
        otpHash: otp.hash,
        // Encrypted at rest; only the Superadmin console decrypts it, on demand.
        otpCipher: encryptField(otp.plaintext),
        status: "PENDING",
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        ipAddress: input.ipAddress ?? null,
      },
    });

    await notify.toSuperadmins({
      type: "auth.password_reset_requested",
      title: "Password reset requested",
      body: `${user.name} (${user.email}) has asked to reset their password.`,
      link: "/platform/password-resets",
    });
  }

  return {
    message: GENERIC_MESSAGE,
    requiresSuperadminRelease: true,
  };
}

/** The requester enters the code their administrator gave them. */
export async function completePasswordReset(input: {
  email: string;
  otp: string;
  newPassword: string;
  ipAddress?: string | null;
}): Promise<void> {
  const email = input.email.trim().toLowerCase();
  await enforce("otpVerify", `email:${email}`);

  const check = checkPassword(input.newPassword);
  if (!check.ok) throw new ValidationError(check.problems.join(" "));

  const request = await prisma.passwordResetRequest.findFirst({
    where: {
      requestedEmail: email,
      // Only a request the owner has actually released can be consumed. A
      // PENDING one is still waiting on a human decision.
      status: "RELEASED",
    },
    orderBy: { createdAt: "desc" },
    include: { user: { select: { id: true, email: true, name: true, organizationId: true } } },
  });

  const invalid = new UnauthorizedError("That code is not valid, or it has expired.");
  if (!request) throw invalid;

  if (request.expiresAt < new Date()) {
    await prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: { status: "EXPIRED" },
    });
    throw invalid;
  }

  if (request.attemptCount >= 5) {
    await prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: { status: "EXPIRED", rejectedReason: "Too many incorrect attempts" },
    });
    throw new ConflictError("Too many incorrect attempts. Ask for a new reset request.");
  }

  const matches = await verifyCode(input.otp.trim(), request.otpHash);
  if (!matches) {
    await prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: { attemptCount: { increment: 1 } },
    });
    throw invalid;
  }

  const passwordHash = await hashPassword(input.newPassword);
  const now = new Date();

  await prisma.$transaction([
    prisma.user.update({
      where: { id: request.userId },
      data: {
        passwordHash,
        passwordChangedAt: now,
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    }),
    prisma.passwordResetRequest.update({
      where: { id: request.id },
      data: {
        status: "CONSUMED",
        consumedAt: now,
        // One-time use: nothing verifiable is left behind.
        otpCipher: null,
      },
    }),
  ]);

  // Someone who just proved control of the account should not leave old sessions
  // (possibly an attacker's) alive.
  await revokeAllSessions(request.userId);

  await writeAnonymousAudit({
    action: "auth.password_reset_consumed",
    entityType: "User",
    entityId: request.userId,
    actorEmail: email,
    organizationId: request.user.organizationId,
    ipAddress: input.ipAddress ?? null,
  });

  await notify.toSuperadmins({
    type: "auth.password_reset_consumed",
    title: "Password reset completed",
    body: `${request.user.name} (${request.user.email}) has set a new password.`,
    link: "/platform/password-resets",
  });
}

// ------------------------------------------------------------------ platform side

export interface ResetRequestRow {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userRole: string;
  organizationName: string | null;
  /**
   * Where the code has to be typed.
   *
   * A code with no address is half an instruction: `/o/<slug>/forgot-password`
   * is the page that accepts it, and the superadmin reading this out is often
   * the only person who knows the slug exists.
   */
  resetUrl: string | null;
  status: string;
  attemptCount: number;
  expiresAt: Date;
  expired: boolean;
  releasedAt: Date | null;
  consumedAt: Date | null;
  ipAddress: string | null;
  createdAt: Date;
}

export async function listResetRequests(ctx: AuthContext): Promise<ResetRequestRow[]> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.passwordreset.read");

  const requests = await prisma.passwordResetRequest.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          organization: { select: { name: true, slug: true } },
        },
      },
    },
  });

  const now = new Date();
  return requests.map((r) => ({
    id: r.id,
    userId: r.userId,
    userName: r.user.name,
    userEmail: r.user.email,
    userRole: r.user.role,
    organizationName: r.user.organization?.name ?? null,
    resetUrl: r.user.organization
      ? `${signInUrl(r.user.organization.slug)}/forgot-password`
      : null,
    status: r.status,
    attemptCount: r.attemptCount,
    expiresAt: r.expiresAt,
    expired: r.expiresAt < now && (r.status === "PENDING" || r.status === "RELEASED"),
    releasedAt: r.releasedAt,
    consumedAt: r.consumedAt,
    ipAddress: r.ipAddress,
    createdAt: r.createdAt,
  }));
}

/**
 * Reveals the code to the platform owner and marks the request released.
 *
 * This is the only path by which the plaintext ever leaves the database, and it
 * is audited every time — including on a re-read, so repeated viewing of a code
 * is visible after the fact.
 */
export async function releaseOtp(ctx: AuthContext, requestId: string): Promise<string> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.passwordreset.release");

  const request = await prisma.passwordResetRequest.findUnique({
    where: { id: requestId },
    include: { user: { select: { email: true, name: true, organizationId: true } } },
  });
  if (!request) throw new NotFoundError("That reset request");

  if (request.status === "CONSUMED") {
    throw new ConflictError("That reset has already been used.");
  }
  if (request.status === "REJECTED") {
    throw new ConflictError("That request was rejected.");
  }
  if (request.expiresAt < new Date()) {
    await prisma.passwordResetRequest.update({
      where: { id: requestId },
      data: { status: "EXPIRED" },
    });
    throw new ConflictError("That request has expired. Ask the user to request a new one.");
  }

  const code = decryptOptional(request.otpCipher);
  if (!code) {
    throw new ConflictError("The code for this request is no longer available. Ask for a new request.");
  }

  await prisma.passwordResetRequest.update({
    where: { id: requestId },
    data: {
      status: "RELEASED",
      releasedAt: request.releasedAt ?? new Date(),
      releasedById: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "auth.password_reset_released",
    entityType: "PasswordResetRequest",
    entityId: requestId,
    organizationId: request.user.organizationId,
    // The code is not recorded — only the fact that it was released, and to whom.
    metadata: { forEmail: request.user.email, reRead: request.releasedAt != null },
  });

  return code;
}

export async function rejectResetRequest(
  ctx: AuthContext,
  requestId: string,
  reason: string,
): Promise<void> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.passwordreset.release");
  if (!reason.trim()) throw new ValidationError("Give a reason for rejecting this request.");

  const request = await prisma.passwordResetRequest.findUnique({
    where: { id: requestId },
    include: { user: { select: { email: true, organizationId: true } } },
  });
  if (!request) throw new NotFoundError("That reset request");
  if (request.status === "CONSUMED") throw new ConflictError("That reset has already been used.");

  await prisma.passwordResetRequest.update({
    where: { id: requestId },
    data: {
      status: "REJECTED",
      rejectedReason: reason.trim(),
      // Nothing verifiable survives a rejection.
      otpCipher: null,
    },
  });

  // Its own action. This used to write `password_reset_released`, so a refusal
  // and a genuine release were the same line in the audit log, told apart only
  // by reading the payload -- and "was a code ever released for this account"
  // is exactly the question somebody comes to this log to answer.
  await writeAudit(ctx, {
    action: "auth.password_reset_rejected",
    entityType: "PasswordResetRequest",
    entityId: requestId,
    organizationId: request.user.organizationId,
    after: { status: "REJECTED", reason: reason.trim() },
  });
}
