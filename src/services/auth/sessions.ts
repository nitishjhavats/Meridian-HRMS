import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";

/**
 * Sessions and sign-in history.
 *
 * The point of this screen is a specific question: "is anybody else signed in
 * as me?" Answering it needs two things — the live sessions, and the recent
 * attempts including the failed ones. A failed login from an unfamiliar place
 * is the signal that matters, and hiding failures hides exactly that.
 *
 * Everything here is scoped to the caller's own user id. There is no
 * administrator view of somebody else's sessions.
 */

export interface SessionRow {
  id: string;
  deviceLabel: string;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  /** The session making this request — it cannot be revoked from here. */
  current: boolean;
}

export async function listSessions(ctx: AuthContext): Promise<SessionRow[]> {
  const sessions = await prisma.session.findMany({
    where: {
      userId: ctx.userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      deviceLabel: true,
      ipAddress: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
    },
  });

  return sessions.map((s) => ({
    id: s.id,
    deviceLabel: s.deviceLabel ?? "Unknown device",
    ipAddress: s.ipAddress,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt?.toISOString() ?? null,
    expiresAt: s.expiresAt.toISOString(),
    current: s.id === ctx.sessionId,
  }));
}

export interface LoginEventRow {
  id: string;
  success: boolean;
  reason: string | null;
  deviceLabel: string;
  ipAddress: string | null;
  createdAt: string;
}

export async function listLoginHistory(ctx: AuthContext, limit = 25): Promise<LoginEventRow[]> {
  const events = await prisma.loginEvent.findMany({
    // Matched on email as well as user id: a failed attempt against an account
    // that could not be resolved still belongs in that person's history.
    where: { OR: [{ userId: ctx.userId }, { email: ctx.email }] },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      success: true,
      reason: true,
      deviceLabel: true,
      ipAddress: true,
      createdAt: true,
    },
  });

  return events.map((e) => ({
    id: e.id,
    success: e.success,
    reason: e.reason,
    deviceLabel: e.deviceLabel ?? "Unknown device",
    ipAddress: e.ipAddress,
    createdAt: e.createdAt.toISOString(),
  }));
}

/** Signs one device out. The current session is deliberately not revocable here. */
export async function revokeSession(ctx: AuthContext, sessionId: string) {
  if (sessionId === ctx.sessionId) {
    // Signing yourself out is what the sign-out button is for; doing it from
    // this screen looks like a mistake and leaves people confused.
    throw new NotFoundError("That session");
  }

  const session = await prisma.session.findFirst({
    where: { id: sessionId, userId: ctx.userId, revokedAt: null },
    select: { id: true, deviceLabel: true },
  });
  if (!session) throw new NotFoundError("That session");

  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date(), revokedById: ctx.userId },
  });

  await writeAudit(ctx, {
    action: "auth.session_revoked",
    entityType: "Session",
    entityId: sessionId,
    after: { deviceLabel: session.deviceLabel, scope: "one" },
  });

  return { id: sessionId };
}

/**
 * Signs every other device out.
 *
 * The one useful action when somebody suspects their account is compromised,
 * and the reason it keeps the current session: they need to stay signed in to
 * go and change their password next.
 */
export async function revokeOtherSessions(ctx: AuthContext) {
  const result = await prisma.session.updateMany({
    where: {
      userId: ctx.userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      id: { not: ctx.sessionId },
    },
    data: { revokedAt: new Date(), revokedById: ctx.userId },
  });

  if (result.count > 0) {
    await writeAudit(ctx, {
      action: "auth.session_revoked",
      entityType: "Session",
      after: { revoked: result.count, scope: "all-others" },
    });
  }

  return { revoked: result.count };
}
