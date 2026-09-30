import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { signImpersonation, verifyImpersonation } from "./impersonation";

/**
 * The reported symptom: "superadmin id se ek baar kiosk impersonate kar deta
 * hoon, phir kiosk logout karne par bhi dubara superadmin login karta hoon to
 * kiosk hi khulta hai."
 *
 * The chain, in full. `hrms_impersonation` is its own thirty-minute cookie.
 * Signing out cleared `hrms_session` and left it alone. Signing back in set a
 * fresh `hrms_session` and, again, left it alone. `loadContext` then saw a
 * superadmin, read the surviving cookie, resolved them as the kiosk device, and
 * `(platform)/layout` bounced them for not being a superadmin while `(app)/layout`
 * sent `role === "KIOSK"` to `/kiosk`. Every guard did exactly what it was
 * written to do.
 *
 * The fix is the session binding below. Everything else is tidying.
 */

const read = (p: string) => readFileSync(path.resolve(p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

beforeAll(() => {
  process.env.AUTH_SECRET ??= "test-secret-that-is-long-enough-for-hs256!!";
});

describe("the token carries the session that opened the visit", () => {
  const claims = {
    target: "user_kiosk",
    org: "org_1",
    reason: "Checking the reception screen",
    readOnly: true,
    bySession: "sess_alpha",
  };

  it("round-trips bySession", async () => {
    const { token } = await signImpersonation(claims);
    await expect(verifyImpersonation(token)).resolves.toMatchObject({
      target: "user_kiosk",
      bySession: "sess_alpha",
    });
  });

  it("refuses a token with no session at all", async () => {
    /**
     * A token minted before this field existed cannot be tied to a sign-in, so
     * it is refused rather than trusted. Built by hand rather than by signing,
     * because `signImpersonation` cannot produce one any more — which is the
     * point.
     */
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(`${process.env.AUTH_SECRET}:impersonation`);
    const legacy = await new SignJWT({ target: "user_kiosk", org: "org_1", readOnly: true })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(secret);

    await expect(verifyImpersonation(legacy)).resolves.toBeNull();
  });
});

describe("the callers", () => {
  it("loadContext refuses a cookie from a different session", () => {
    const code = strip(read("src/lib/auth/context.ts"));
    expect(code).toMatch(/claims\.bySession !== session\.sid/);

    // And it must refuse *before* it goes and loads the target, or the refusal
    // is only saving a redirect and not a database round trip.
    const refusal = code.indexOf("claims.bySession !== session.sid");
    const load = code.indexOf("contextForUser(claims.target");
    expect(refusal).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(load);
  });

  it("startImpersonation stamps the impersonator's own session on the token", () => {
    const code = strip(read("src/services/platform/impersonation.ts"));
    expect(code).toMatch(/bySession:\s*ctx\.sessionId/);
  });

  it("signing in and signing out both clear the cookie", () => {
    for (const file of ["src/app/api/auth/login/route.ts", "src/app/api/auth/logout/route.ts"]) {
      expect(strip(read(file))).toMatch(/clearImpersonationCookie\(\)/);
    }
  });

  it("signing out of a visit does not revoke the superadmin's session", () => {
    const code = strip(read("src/app/api/auth/logout/route.ts"));

    /**
     * While impersonating, `ctx.userId` is the target's and `ctx.sessionId` is
     * still the superadmin's — so `revokeSession(ctx.sessionId, ctx.userId)`
     * revoked the superadmin's own session and recorded the kiosk device as
     * having revoked it. The impersonating branch must return before it.
     */
    const branch = code.indexOf("ctx?.impersonating");
    const revoke = code.indexOf("revokeSession(");
    expect(branch).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(revoke);
    expect(code.slice(branch, revoke)).toMatch(/return json\(/);
  });

  it("the kiosk offers a way out of a visit, having no app shell to put one in", () => {
    const code = strip(read("src/app/kiosk/KioskScreen.tsx"));
    expect(code).toMatch(/impersonating/);
    expect(code).toMatch(/\/api\/platform\/impersonation/);
    // And it follows the route's own answer rather than hardcoding /login.
    expect(code).toMatch(/redirectTo/);
  });
});
