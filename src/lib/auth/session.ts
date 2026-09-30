import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { prisma } from "../db/prisma";
import { randomToken, sha256 } from "../crypto/field";
import { UnauthorizedError } from "../errors";
import type { SystemRole } from "./permissions";

/**
 * Sessions.
 *
 * A signed JWT in an httpOnly cookie carries identity; a `Session` row makes it
 * revocable. Both must agree — a token whose row is missing, revoked or expired
 * is rejected, which is what makes "sign out everywhere" and the device manager
 * actually work.
 *
 * The tenant (`orgId`) lives in the token and is never read from a request body
 * or query string.
 */

export const SESSION_COOKIE = "hrms_session";

export interface SessionClaims {
  /** User id. */
  sub: string;
  /** Organisation id; null for the platform Superadmin. */
  org: string | null;
  role: SystemRole;
  /** Session row id, so a token can be revoked individually. */
  sid: string;
}

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error(
      "AUTH_SECRET is missing or too short. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"",
    );
  }
  return new TextEncoder().encode(value);
}

/**
 * How long a person stays signed in: thirty days from the last time they
 * used it.
 *
 * It was twelve hours, fixed, with no renewal -- `SESSION_MAX_AGE_SECONDS`.
 * On a phone with the app installed that meant every morning began signed
 * out, and because the sign-out was only noticed by the next page tapped, it
 * began with "Something went wrong". The owner's answer, asked directly: thirty
 * days, sliding. The row's `expiresAt` moves forward on use (`touchSession`);
 * Account -> Security lists every session and revokes any of them at once.
 *
 * `SESSION_IDLE_DAYS` overrides the window. The old variable is read no more:
 * it is still set on the live instance, to twelve hours, and honouring it would
 * quietly keep the behaviour this replaces.
 */
export const SESSION_IDLE_DAYS_DEFAULT = 30;

function idleSeconds(): number {
  const raw = Number(process.env.SESSION_IDLE_DAYS ?? SESSION_IDLE_DAYS_DEFAULT);
  const days = Number.isFinite(raw) && raw > 0 ? raw : SESSION_IDLE_DAYS_DEFAULT;
  return Math.round(days * 24 * 60 * 60);
}

/**
 * The cookie and the token outlive the row on purpose.
 *
 * The row's `expiresAt` is the authority -- `verifySessionToken` refuses a row
 * past it, and revocation is a row update -- and it slides. The cookie and the
 * signed token cannot slide without being re-issued on every request, so they
 * are given a far horizon instead (browsers cap a cookie at 400 days) and the
 * row decides. A kiosk keeps its fixed thirty days: nobody is there to renew
 * it, and the exposure is bounded by the role, not the clock.
 */
const COOKIE_HORIZON_SECONDS = 400 * 24 * 60 * 60;

export interface CreateSessionInput {
  userId: string;
  organizationId: string | null;
  role: SystemRole;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * How long a shared office device stays signed in.
 *
 * A person's session slides on use and lapses when unused; a device is used
 * by everybody and owned by nobody, so it would lapse over a long weekend and
 * need somebody with the device password. Thirty days, fixed, is the trade,
 * and the exposure is bounded
 * by the role rather than by the clock: a KIOSK session can do nothing but mark
 * attendance, it appears in the admin's session list, and revoking it takes
 * effect immediately.
 */
export const KIOSK_SESSION_SECONDS = 30 * 24 * 60 * 60;

export interface IssuedSession {
  token: string;
  sessionId: string;
  /** When the row lapses if unused. Slides on use. */
  expiresAt: Date;
  /** When the cookie itself falls off the device. Far beyond the row. */
  cookieExpiresAt: Date;
}

/** Creates the DB row and signs the token. The caller sets the cookie. */
export async function createSession(input: CreateSessionInput): Promise<IssuedSession> {
  const raw = randomToken(32);
  const lifetime = input.role === "KIOSK" ? KIOSK_SESSION_SECONDS : idleSeconds();
  const expiresAt = new Date(Date.now() + lifetime * 1000);
  const horizon = new Date(Date.now() + COOKIE_HORIZON_SECONDS * 1000);

  const session = await prisma.session.create({
    data: {
      userId: input.userId,
      tokenHash: sha256(raw),
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      deviceLabel:
        input.role === "KIOSK"
          ? `Office device · ${describeDevice(input.userAgent)}`
          : describeDevice(input.userAgent),
      lastSeenAt: new Date(),
      expiresAt,
    },
    select: { id: true },
  });

  const token = await new SignJWT({
    org: input.organizationId,
    role: input.role,
    sid: session.id,
    // The raw token is bound into the JWT so possession of the JWT alone is not
    // enough — the hash must match the stored row.
    tkn: raw,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(horizon.getTime() / 1000))
    .sign(secret());

  return { token, sessionId: session.id, expiresAt, cookieExpiresAt: horizon };
}

export interface VerifiedSession extends SessionClaims {
  expiresAt: Date;
}

/**
 * Verifies signature, expiry, and that the backing row is still live.
 * Returns null rather than throwing, so callers can redirect instead of erroring.
 */
export async function verifySessionToken(token: string): Promise<VerifiedSession | null> {
  /**
   * Only the token's own faults mean "not signed in". A database that cannot
   * be reached used to fall into the same catch, and now that a 401 sends the
   * browser to the login screen, a thirty-second blip would have signed
   * everybody out. It is a 500 instead, and the person stays where they are.
   */
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    payload = (await jwtVerify(token, secret(), { algorithms: ["HS256"] })).payload;
  } catch {
    return null;
  }
  {
    const sid = typeof payload.sid === "string" ? payload.sid : null;
    const raw = typeof payload.tkn === "string" ? payload.tkn : null;
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (!sid || !raw || !sub) return null;

    const row = await prisma.session.findUnique({
      where: { id: sid },
      select: { id: true, userId: true, tokenHash: true, revokedAt: true, expiresAt: true },
    });

    if (!row || row.revokedAt || row.userId !== sub) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    if (row.tokenHash !== sha256(raw)) return null;

    return {
      sub,
      org: (payload.org as string | null) ?? null,
      role: payload.role as SystemRole,
      sid,
      expiresAt: row.expiresAt,
    };
  }
}

export async function readSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function currentSession(): Promise<VerifiedSession | null> {
  const token = await readSessionCookie();
  if (!token) return null;
  return verifySessionToken(token);
}

export async function requireSession(): Promise<VerifiedSession> {
  const session = await currentSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...sessionCookieOptions(new Date(0)), expires: new Date(0) });
}

export async function revokeSession(sessionId: string, revokedById?: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: revokedById ?? null },
  });
}

/** Sign out everywhere; `exceptSessionId` keeps the current device signed in. */
export async function revokeAllSessions(
  userId: string,
  options: { exceptSessionId?: string; revokedById?: string } = {},
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { NOT: { id: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedById: options.revokedById ?? null },
  });
  return result.count;
}

/**
 * Marks the session used, and slides its expiry.
 *
 * Every request already wrote `lastSeenAt`; the expiry moves in the same write.
 * A kiosk is not slid -- its thirty days are fixed by design.
 */
export async function touchSession(sessionId: string, role?: SystemRole): Promise<void> {
  const now = new Date();
  await prisma.session
    .update({
      where: { id: sessionId },
      data: {
        lastSeenAt: now,
        ...(role === "KIOSK" ? {} : { expiresAt: new Date(now.getTime() + idleSeconds() * 1000) }),
      },
    })
    .catch(() => undefined);
}

/** Best-effort friendly device name for the session list. */
export function describeDevice(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";

  const browser =
    /Edg\//.test(userAgent) ? "Edge"
    : /OPR\//.test(userAgent) ? "Opera"
    : /Chrome\//.test(userAgent) ? "Chrome"
    : /Firefox\//.test(userAgent) ? "Firefox"
    : /Safari\//.test(userAgent) ? "Safari"
    : "Browser";

  const platform =
    /Windows/.test(userAgent) ? "Windows"
    : /Android/.test(userAgent) ? "Android"
    : /iPhone|iPad|iPod/.test(userAgent) ? "iOS"
    : /Mac OS X/.test(userAgent) ? "macOS"
    : /Linux/.test(userAgent) ? "Linux"
    : "Unknown OS";

  return `${browser} on ${platform}`;
}
