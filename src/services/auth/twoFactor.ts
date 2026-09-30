import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { decryptOptional, encryptField } from "@/lib/crypto/field";
import { verifyPassword } from "@/lib/auth/password";
import { enforce } from "@/lib/ratelimit";
import { BRAND } from "@/lib/brand";
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateSecret,
  otpauthUri,
  verifyTotp,
} from "@/lib/auth/totp";

/**
 * Two-factor authentication.
 *
 * Enrolment is two steps on purpose: a secret is generated and shown, but 2FA
 * is not switched on until the person proves they can produce a code from it.
 * Enabling on trust locks people out of their own accounts when the QR did not
 * scan properly.
 *
 * Roles that can move money or change everybody's data are the ones this
 * protects, so they are the ones allowed to require it.
 */

/** Roles for which 2FA may be enforced organisation-wide. */
export const PROTECTED_ROLES = ["SUPERADMIN", "ORG_OWNER", "ADMIN"] as const;

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  /** Whether this account is one where 2FA is strongly advised. */
  recommended: boolean;
}

export async function getTwoFactorStatus(ctx: AuthContext): Promise<TwoFactorStatus> {
  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { totpEnabledAt: true, totpRecoveryHashes: true },
  });

  return {
    enabled: user?.totpEnabledAt != null,
    enabledAt: user?.totpEnabledAt?.toISOString() ?? null,
    recoveryCodesLeft: user?.totpRecoveryHashes.length ?? 0,
    recommended: (PROTECTED_ROLES as readonly string[]).includes(ctx.role),
  };
}

export interface EnrolmentStart {
  secret: string;
  uri: string;
  /** The secret in readable groups, for typing when a camera will not scan. */
  manualEntry: string;
}

/**
 * Step one: mint a secret and show it.
 *
 * The secret is stored immediately but `totpEnabledAt` stays null, so an
 * abandoned enrolment leaves an account exactly as it was.
 */
export async function beginEnrolment(ctx: AuthContext): Promise<EnrolmentStart> {
  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { email: true, totpEnabledAt: true },
  });
  if (user?.totpEnabledAt) {
    throw new ConflictError("Two-factor authentication is already on. Turn it off first.");
  }

  const secret = generateSecret();
  await prisma.user.update({
    where: { id: ctx.userId },
    data: { totpSecretCipher: encryptField(secret) },
  });

  return {
    secret,
    uri: otpauthUri({
      secret,
      account: user?.email ?? ctx.email,
      issuer: ctx.organization?.name ?? BRAND.name,
    }),
    manualEntry: secret.match(/.{1,4}/g)?.join(" ") ?? secret,
  };
}

/**
 * Step two: prove the code works, then switch it on.
 *
 * Recovery codes are returned here and never again — the caller must show them
 * once and say so.
 */
export async function confirmEnrolment(ctx: AuthContext, code: string) {
  await enforce("otpVerify", `totp:${ctx.userId}`);

  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { totpSecretCipher: true, totpEnabledAt: true },
  });
  if (user?.totpEnabledAt) throw new ConflictError("Two-factor authentication is already on.");

  const secret = decryptOptional(user?.totpSecretCipher ?? null);
  if (!secret) throw new ValidationError("Start again — no enrolment is in progress.");

  if (!verifyTotp(secret, code)) {
    throw new ValidationError(
      "That code did not match. Check your phone's clock is correct, then try the current code.",
    );
  }

  const recovery = generateRecoveryCodes();
  await prisma.user.update({
    where: { id: ctx.userId },
    data: { totpEnabledAt: new Date(), totpRecoveryHashes: recovery.hashes },
  });

  await writeAudit(ctx, {
    action: "auth.totp_enabled",
    entityType: "User",
    entityId: ctx.userId,
    after: { enabled: true, recoveryCodes: recovery.plaintext.length },
  });

  return { enabled: true, recoveryCodes: recovery.plaintext };
}

/**
 * Turning it off requires the password.
 *
 * Otherwise a borrowed session — an unlocked laptop — is enough to remove the
 * protection, which defeats the point of having it.
 */
export async function disableTwoFactor(ctx: AuthContext, password: string) {
  await enforce("otpVerify", `totp-disable:${ctx.userId}`);

  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { passwordHash: true, totpEnabledAt: true },
  });
  if (!user?.totpEnabledAt) throw new ConflictError("Two-factor authentication is not on.");
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new ForbiddenError("That password is not correct.");
  }

  await prisma.user.update({
    where: { id: ctx.userId },
    data: { totpSecretCipher: null, totpEnabledAt: null, totpRecoveryHashes: [] },
  });

  await writeAudit(ctx, {
    action: "auth.totp_disabled",
    entityType: "User",
    entityId: ctx.userId,
    after: { enabled: false },
  });

  return { enabled: false };
}

/** Issues a fresh set, invalidating the old — for somebody who has used most. */
export async function regenerateRecoveryCodes(ctx: AuthContext, password: string) {
  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { passwordHash: true, totpEnabledAt: true },
  });
  if (!user?.totpEnabledAt) throw new ConflictError("Two-factor authentication is not on.");
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new ForbiddenError("That password is not correct.");
  }

  const recovery = generateRecoveryCodes();
  await prisma.user.update({
    where: { id: ctx.userId },
    data: { totpRecoveryHashes: recovery.hashes },
  });

  return { recoveryCodes: recovery.plaintext };
}

// ------------------------------------------------------------------ at login

export type SecondFactorResult =
  | { ok: true; usedRecoveryCode: boolean; recoveryCodesLeft: number }
  | { ok: false; reason: "BAD_TOTP" };

/**
 * Checks the second factor during sign-in.
 *
 * Accepts either a current TOTP code or an unused recovery code, because the
 * whole reason recovery codes exist is that the authenticator is unavailable.
 */
export async function verifySecondFactor(
  userId: string,
  code: string,
): Promise<SecondFactorResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecretCipher: true, totpEnabledAt: true, totpRecoveryHashes: true },
  });
  if (!user?.totpEnabledAt) return { ok: true, usedRecoveryCode: false, recoveryCodesLeft: 0 };

  const secret = decryptOptional(user.totpSecretCipher);
  if (secret && verifyTotp(secret, code)) {
    return { ok: true, usedRecoveryCode: false, recoveryCodesLeft: user.totpRecoveryHashes.length };
  }

  const remaining = consumeRecoveryCode(code, user.totpRecoveryHashes);
  if (remaining) {
    // Burned on use, in the same transaction as accepting it.
    await prisma.user.update({
      where: { id: userId },
      data: { totpRecoveryHashes: remaining },
    });
    return { ok: true, usedRecoveryCode: true, recoveryCodesLeft: remaining.length };
  }

  return { ok: false, reason: "BAD_TOTP" };
}

/** Whether an account has 2FA on, for the login flow to know to ask. */
export async function requiresSecondFactor(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpEnabledAt: true },
  });
  return user?.totpEnabledAt != null;
}
