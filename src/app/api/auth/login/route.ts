import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { fakeVerify, verifyPassword } from "@/lib/auth/password";
import { createSession, describeDevice, setSessionCookie } from "@/lib/auth/session";
import { writeAnonymousAudit } from "@/lib/audit";
import { AppError, UnauthorizedError } from "@/lib/errors";
import { clientIdentifier, enforce, reset } from "@/lib/ratelimit";
import { json, parseBody, publicRoute, requestMeta } from "@/lib/http/handler";
import { landingFor } from "@/lib/auth/landing";
import { clearImpersonationCookie } from "@/lib/auth/impersonation";
import { requiresSecondFactor, verifySecondFactor } from "@/services/auth/twoFactor";

/**
 * Sign in.
 *
 * Everything a failed attempt returns is deliberately identical — "email or
 * password is incorrect" — whether the account is missing, the password is wrong
 * or the organisation is suspended. Anything more specific turns the login form
 * into a directory of who works where.
 *
 * The one exception is a locked account, where staying silent would leave someone
 * repeatedly failing with a password they know is right.
 */

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
  /** Required only when one email exists in more than one organisation. */
  organizationId: z.string().optional(),
  /** A TOTP code or a recovery code, when the account has 2FA on. */
  totp: z.string().trim().max(40).optional(),
});

const MAX_CANDIDATES = 5;
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;

export const POST = publicRoute(async (request) => {
  const body = await parseBody(request, loginSchema);
  const meta = requestMeta(request);
  const ip = clientIdentifier(request.headers);

  // Two limiters: one per IP so a single host cannot spray the whole user base,
  // one per email so a distributed attack still cannot grind one account.
  await enforce("login", `ip:${ip}`);
  await enforce("login", `email:${body.email}`);

  const candidateSelect = {
      id: true,
      email: true,
      name: true,
      passwordHash: true,
      role: true,
      status: true,
      lockedUntil: true,
      failedLoginCount: true,
      mustChangePassword: true,
      organizationId: true,
      organization: { select: { id: true, name: true, slug: true, status: true } },
  } as const;

  // The organisation, when the door names one, is a tie-breaker and nothing
  // more: it picks between two accounts with the same address, one per
  // organisation. It is not a wall. The platform owner has no organisation at
  // all, and a person whose only account is elsewhere is still that person --
  // refusing them here as "incorrect" would have been a lie that also counted
  // against their address's limiter. So a door that finds nobody looks again
  // without the filter; the password is still checked against whatever it
  // finds, so nothing signs in here that would not sign in at /login.
  let candidates = await prisma.user.findMany({
    where: {
      email: body.email,
      ...(body.organizationId ? { organizationId: body.organizationId } : {}),
    },
    take: MAX_CANDIDATES,
    select: candidateSelect,
  });
  if (candidates.length === 0 && body.organizationId) {
    candidates = await prisma.user.findMany({
      where: { email: body.email },
      take: MAX_CANDIDATES,
      select: candidateSelect,
    });
  }

  if (candidates.length === 0) {
    // Burn the same time a real bcrypt comparison would, so response timing
    // does not reveal whether the address exists.
    await fakeVerify();
    await recordFailure(body.email, null, "NO_SUCH_USER", meta);
    throw invalidCredentials();
  }

  const now = new Date();
  const matches: typeof candidates = [];

  for (const candidate of candidates) {
    if (candidate.lockedUntil && candidate.lockedUntil > now) {
      await recordFailure(body.email, candidate.id, "LOCKED", meta);
      throw new AppError(
        "RATE_LIMITED",
        429,
        "This account is temporarily locked after too many failed attempts. Try again in a few minutes.",
      );
    }
    if (await verifyPassword(body.password, candidate.passwordHash)) matches.push(candidate);
  }

  if (matches.length === 0) {
    const target = candidates[0];
    if (target) await registerFailedAttempt(target.id, target.failedLoginCount);
    await recordFailure(body.email, candidates[0]?.id ?? null, "BAD_PASSWORD", meta);
    throw invalidCredentials();
  }

  // The same person in more than one organisation: ask which one, but only after
  // the password has already been proven.
  if (matches.length > 1) {
    return json(
      {
        needsOrganization: true,
        organizations: matches
          .filter((m) => m.organization)
          .map((m) => ({ id: m.organization!.id, name: m.organization!.name })),
      },
      { status: 300 },
    );
  }

  const user = matches[0]!;

  if (user.status === "SUSPENDED" || user.status === "DISABLED") {
    await recordFailure(body.email, user.id, "SUSPENDED", meta);
    throw invalidCredentials();
  }

  // A suspended or archived organisation cannot be entered by anyone but the
  // platform owner, who has no organizationId at all.
  if (user.organization && (user.organization.status === "SUSPENDED" || user.organization.status === "ARCHIVED")) {
    await recordFailure(body.email, user.id, "ORG_SUSPENDED", meta);
    throw new UnauthorizedError(
      "Your organisation's access is currently suspended. Please contact your administrator.",
    );
  }

  // The second factor is checked only after the password has been proven, so a
  // wrong password never reveals whether an account has 2FA at all.
  if (await requiresSecondFactor(user.id)) {
    if (!body.totp) {
      return json({ needsSecondFactor: true }, { status: 300 });
    }

    await enforce("otpVerify", `login-totp:${user.id}`);
    const second = await verifySecondFactor(user.id, body.totp);

    if (!second.ok) {
      await recordFailure(body.email, user.id, "BAD_TOTP", meta);
      throw new UnauthorizedError("That authentication code is not valid.");
    }

    if (second.usedRecoveryCode) {
      await writeAnonymousAudit({
        action: "auth.login",
        entityType: "User",
        entityId: user.id,
        actorEmail: user.email,
        organizationId: user.organizationId,
        metadata: { via: "recovery-code", recoveryCodesLeft: second.recoveryCodesLeft },
        ...meta,
      });
    }
  }

  const session = await createSession({
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  await Promise.all([
    prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now, failedLoginCount: 0, lockedUntil: null },
    }),
    prisma.loginEvent.create({
      data: {
        userId: user.id,
        organizationId: user.organizationId,
        email: user.email,
        success: true,
        reason: "OK",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        deviceLabel: describeDevice(meta.userAgent),
      },
    }),
    writeAnonymousAudit({
      action: "auth.login",
      entityType: "User",
      entityId: user.id,
      actorEmail: user.email,
      organizationId: user.organizationId,
      ...meta,
    }),
    reset("login", `email:${body.email}`),
  ]);

  await setSessionCookie(session.token, session.cookieExpiresAt);

  /**
   * A new sign-in starts with no support visit in progress.
   *
   * The session binding in `ImpersonationClaims` already makes a cookie from a
   * previous sign-in inert, so this is not what closes the hole. It is here so
   * a dead cookie does not sit in the browser for the rest of its half hour
   * being refused on every request.
   */
  await clearImpersonationCookie();

  /**
   * Signing in from the product's own door lands on the organisation's.
   *
   * `/o/<slug>` forwards straight to the dashboard, so this costs one hop and
   * buys something real: the address in the browser's history — and therefore
   * the one somebody bookmarks or reaches for with Back — is their own
   * organisation's, not a generic sign-in page shared with every other
   * customer. The platform owner and a kiosk device have no slug and keep
   * their own landing.
   */
  const slug = user.organization?.slug ?? null;
  const redirectTo =
    slug && user.role !== "SUPERADMIN" && user.role !== "KIOSK"
      ? `/o/${slug}`
      : landingFor(user.role);

  return json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    mustChangePassword: user.mustChangePassword,
    redirectTo,
  });
});

function invalidCredentials(): AppError {
  return new UnauthorizedError("That email or password is incorrect.");
}

async function registerFailedAttempt(userId: string, current: number): Promise<void> {
  const next = current + 1;
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: next,
      ...(next >= LOCKOUT_THRESHOLD
        ? { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000), failedLoginCount: 0 }
        : {}),
    },
  });
}

async function recordFailure(
  email: string,
  userId: string | null,
  reason: string,
  meta: { ipAddress: string | null; userAgent: string | null },
): Promise<void> {
  await prisma.loginEvent
    .create({
      data: {
        userId,
        email,
        success: false,
        reason,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        deviceLabel: describeDevice(meta.userAgent),
      },
    })
    .catch(() => undefined);
}

