import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Thirty days from the last use, sliding.
 *
 * It was twelve hours, fixed, with no renewal -- so a phone with the app
 * installed began every morning signed out, and (until the page-level fix)
 * began it with "Something went wrong". The owner's answer, asked directly:
 * thirty days, sliding. The row is the authority and moves on use; the cookie
 * and token are given a far horizon because they cannot move without being
 * re-issued on every request.
 */

const SESSION = path.resolve("src/lib/auth/session.ts");

function code(): string {
  return readFileSync(SESSION, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("how long a person stays signed in", () => {
  it("defaults to thirty days, and reads a days variable rather than the old seconds one", () => {
    const body = code();
    expect(body).toMatch(/SESSION_IDLE_DAYS_DEFAULT = 30/);
    expect(body).toMatch(/process\.env\.SESSION_IDLE_DAYS/);
    // Still set to twelve hours on the live instance; honouring it would keep
    // the behaviour this replaces.
    expect(body).not.toMatch(/SESSION_MAX_AGE_SECONDS/);
  });

  it("slides the row's expiry on every touch, except for a device", () => {
    const body = code();
    const start = body.indexOf("export async function touchSession");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    expect(block).toMatch(/lastSeenAt: now/);
    expect(block).toMatch(/role === "KIOSK" \? \{\} : \{ expiresAt: new Date\(now\.getTime\(\) \+ idleSeconds\(\) \* 1000\) \}/);
  });

  it("the token and cookie outlive the row, because the row decides", () => {
    const body = code();
    expect(body).toMatch(/COOKIE_HORIZON_SECONDS = 400 \* 24 \* 60 \* 60/);
    expect(body).toMatch(/\.setExpirationTime\(Math\.floor\(horizon\.getTime\(\) \/ 1000\)\)/);
    expect(body).toMatch(/cookieExpiresAt: horizon/);
    // Verification still refuses a lapsed row.
    expect(body).toMatch(/if \(row\.expiresAt\.getTime\(\) <= Date\.now\(\)\) return null;/);
  });

  it("the login and sign-up routes set the cookie to the horizon, not the row", () => {
    for (const f of ["src/app/api/auth/login/route.ts", "src/app/api/auth/signup/route.ts"]) {
      expect(readFileSync(path.resolve(f), "utf8"), f).toMatch(
        /setSessionCookie\(session\.token, session\.cookieExpiresAt\)/,
      );
    }
  });

  it("the context touches with the role, so a kiosk is not slid", () => {
    expect(readFileSync(path.resolve("src/lib/auth/context.ts"), "utf8")).toMatch(
      /touchSession\(session\.sid, session\.role\)/,
    );
  });
});
