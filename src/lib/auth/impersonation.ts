import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

/**
 * The platform owner acting as somebody inside a customer's organisation.
 *
 * **Why this is a second cookie and not a second session.** `loadContext`
 * refuses any session whose `org` claim disagrees with the user's own
 * organisation — it is the one place a forged or stale tenant claim is caught,
 * and a superadmin's organisation is `null`. Minting a session as the target
 * would mean weakening that check for everybody in order to serve one feature.
 * So the real session is validated exactly as it always was, and this rides
 * beside it: only honoured when the account behind the session is genuinely a
 * SUPERADMIN, and carrying nothing that grants anything by itself.
 *
 * Thirty minutes, and no renewal. Support work is a visit, not a tenancy.
 *
 * Writes are permitted, which was a deliberate choice over a read-only support
 * view: a platform owner who can only look cannot fix the misconfiguration they
 * were called about. What that costs is honesty in the log, so every audit row
 * written while this is live names both the person acted as and the superadmin
 * doing it. The customer's own audit trail never claims their administrator did
 * something Broadmate did.
 */

export const IMPERSONATION_COOKIE = "hrms_impersonation";
export const IMPERSONATION_SECONDS = 30 * 60;

export interface ImpersonationClaims {
  /** The user being acted as. */
  target: string;
  /** Their organisation, checked against the target's own row before it is used. */
  org: string;
  /** Why, recorded on the audit row that opened the session. */
  reason: string;
  /**
   * Look, do not touch.
   *
   * Off by default — a platform owner who can only look cannot fix the
   * misconfiguration they were called about. It is offered because plenty of
   * support visits are only ever a question ("what does their leave screen
   * actually show?"), and answering one should not carry the ability to lock a
   * payroll run by accident. `requireWritable` enforces it.
   */
  readOnly: boolean;
  /** When the visit ends. Shown on the banner, so the end is not a surprise. */
  expiresAt: Date;
  /**
   * The session that opened this visit.
   *
   * Without it, the cookie outlived the sign-in that created it. A superadmin
   * impersonating an office device would be sent to `/kiosk`, sign the *device*
   * out — which clears `hrms_session` and leaves this cookie untouched — and
   * then sign back in as themselves, whereupon `loadContext` read the surviving
   * cookie, resolved them as the kiosk again, and both layouts bounced them
   * straight back to the kiosk screen. They were locked out of their own
   * console for half an hour with nothing on screen to explain it.
   *
   * Binding the visit to the session id fixes it at the root: signing in makes
   * a new session, and a cookie naming the old one is refused rather than
   * honoured. Clearing the cookie on sign-in and sign-out is belt and braces on
   * top of this, not instead of it.
   */
  bySession: string;
}

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error("AUTH_SECRET is missing or too short.");
  }
  // A different signing purpose from a session token, so one can never be
  // presented as the other even though both are HS256 over the same secret.
  return new TextEncoder().encode(`${value}:impersonation`);
}

export async function signImpersonation(
  claims: Omit<ImpersonationClaims, "expiresAt">,
): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const expiresAt = new Date(Date.now() + IMPERSONATION_SECONDS * 1000);
  // `expiresAt` is the token's own `exp`, read back on verify -- not a claim.
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret());
  return { token, expiresAt };
}

export async function verifyImpersonation(token: string): Promise<ImpersonationClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const target = typeof payload.target === "string" ? payload.target : null;
    const org = typeof payload.org === "string" ? payload.org : null;
    const reason = typeof payload.reason === "string" ? payload.reason : "";
    const bySession = typeof payload.bySession === "string" ? payload.bySession : null;
    // A token minted before `bySession` existed cannot be tied to a session, so
    // it is refused rather than trusted. The cost is that a visit in flight at
    // deploy time ends; the alternative is keeping the hole open for exactly
    // the tokens that were issued without it.
    if (!target || !org || !bySession) return null;
    const expiresAt = new Date((typeof payload.exp === "number" ? payload.exp : 0) * 1000);
    return { target, org, reason, bySession, readOnly: payload.readOnly === true, expiresAt };
  } catch {
    return null;
  }
}

export async function readImpersonationCookie(): Promise<ImpersonationClaims | null> {
  const store = await cookies();
  const token = store.get(IMPERSONATION_COOKIE)?.value;
  if (!token) return null;
  return verifyImpersonation(token);
}

export async function setImpersonationCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(IMPERSONATION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearImpersonationCookie(): Promise<void> {
  const store = await cookies();
  store.set(IMPERSONATION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
  });
}
