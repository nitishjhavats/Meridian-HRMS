import { prisma } from "./db/prisma";
import { RateLimitError } from "./errors";
import { clientIp } from "./http/clientIp";

/**
 * Rate limiting backed by a Postgres counter table.
 *
 * A database counter rather than an in-memory map, because Next.js route handlers
 * can run in several processes and an in-memory limiter would then be trivially
 * bypassed. Swap this for Redis if the deployment ever needs it — the interface
 * stays the same.
 */

export interface RateLimitRule {
  /** Maximum attempts inside the window. */
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMITS = {
  login: { limit: 8, windowSeconds: 300 },
  signup: { limit: 3, windowSeconds: 3_600 },
  signupEmail: { limit: 3, windowSeconds: 86_400 },
  passwordReset: { limit: 5, windowSeconds: 900 },
  otpVerify: { limit: 5, windowSeconds: 900 },
  paymentCode: { limit: 5, windowSeconds: 900 },
  attendanceMark: { limit: 20, windowSeconds: 300 },
  aiRequest: { limit: 20, windowSeconds: 3_600 },
  fileUpload: { limit: 40, windowSeconds: 3_600 },
  export: { limit: 5, windowSeconds: 3_600 },
  // Fifty a day, keyed on the employee *and the date* -- see `services/chat`.
  // The window only stops a spent counter outliving its day; the key is what
  // makes it a calendar day rather than a rolling twenty-four hours, which
  // would block somebody at 3pm for messages they sent at 4pm yesterday.
  //
  // Deliberately not in FAIL_CLOSED: this guards capacity, not a credential,
  // and silencing an entire company's chat because a counter is unreachable is
  // the worse outcome.
  chatMessage: { limit: 50, windowSeconds: 172_800 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/**
 * Limits that refuse rather than wave through when the counter is unreachable.
 *
 * Every one of these guards a credential. `attendanceMark`, `fileUpload`,
 * `aiRequest` and `export` are deliberately absent: they protect capacity, not
 * an account, and refusing somebody's check-in because a counter is down is a
 * worse outcome than the one being prevented.
 */
const FAIL_CLOSED: ReadonlySet<RateLimitName> = new Set([
  "login",
  "signup",
  "passwordReset",
  "otpVerify",
  "paymentCode",
]);

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Consumes one unit against `name:identifier`.
 *
 * The counter row is reset rather than deleted once its window passes, so a
 * long-idle key costs one upsert instead of accumulating rows.
 */
export async function consume(
  name: RateLimitName,
  identifier: string,
  overrides?: Partial<RateLimitRule>,
): Promise<RateLimitResult> {
  const rule = { ...RATE_LIMITS[name], ...overrides };
  const id = `${name}:${identifier}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + rule.windowSeconds * 1000);

  try {
    const existing = await prisma.rateLimitCounter.findUnique({ where: { id } });

    if (!existing || existing.expiresAt <= now) {
      await prisma.rateLimitCounter.upsert({
        where: { id },
        create: { id, count: 1, expiresAt },
        update: { count: 1, expiresAt },
      });
      return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= rule.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.expiresAt.getTime() - now.getTime()) / 1000)),
      };
    }

    const updated = await prisma.rateLimitCounter.update({
      where: { id },
      data: { count: { increment: 1 } },
      select: { count: true },
    });

    return {
      allowed: true,
      remaining: Math.max(0, rule.limit - updated.count),
      retryAfterSeconds: 0,
    };
  } catch (error) {
    /**
     * A broken limiter must not lock everybody out of the product — but on the
     * endpoints where the limit *is* the control, failing open turns a database
     * blip into an unthrottled guessing window on a public URL.
     *
     * So the two behaviours are split by what the limit is protecting. Marking
     * attendance fails open: the worst case is somebody checking in twice.
     * Signing in, creating an organisation, resetting a password, redeeming a
     * kiosk PIN and a supervisor override fail closed: the worst case there is
     * somebody getting into an account that is not theirs.
     */
    console.error("[ratelimit] counter unavailable", { id, name, error });
    if (FAIL_CLOSED.has(name)) {
      return { allowed: false, remaining: 0, retryAfterSeconds: 30 };
    }
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0 };
  }
}

/** Consumes and throws a 429 when exhausted. */
export async function enforce(
  name: RateLimitName,
  identifier: string,
  overrides?: Partial<RateLimitRule>,
): Promise<void> {
  const result = await consume(name, identifier, overrides);
  if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
}

/** Clears a key after a successful attempt, so a good login resets the counter. */
export async function reset(name: RateLimitName, identifier: string): Promise<void> {
  await prisma.rateLimitCounter.deleteMany({ where: { id: `${name}:${identifier}` } });
}

/** Housekeeping: drop expired counters. Called by the maintenance job. */
export async function purgeExpired(): Promise<number> {
  const result = await prisma.rateLimitCounter.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

/** Client identifier for anonymous endpoints, behind a proxy or not. */
export function clientIdentifier(headers: Headers, fallback = "unknown"): string {
  return clientIp(headers) ?? fallback;
}
