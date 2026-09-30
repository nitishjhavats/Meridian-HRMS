import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A dead session ends on the login screen, never on the error screen.
 *
 * The layouts caught `requireContext()` and redirected; on a soft navigation
 * the layout does not run, the page does, and sixty pages threw `Unauthorized`
 * into `error.tsx` -- whose two buttons threw again. Seven times in one day on
 * the live instance, at eight in the morning, on the pages people open first.
 * In an installed app there is no address bar to reload from.
 *
 * Source assertions, because what is pinned is which helper every page calls
 * and what the boundaries do before they show a fault.
 */

const ROOT = path.resolve("src/app");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function source(file: string): string {
  return readFileSync(file, "utf8");
}

function code(file: string): string {
  return source(file)
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const pages = walk(ROOT).filter((f) => f.endsWith("page.tsx"));

describe("every page asks for its context through the redirecting helper", () => {
  it("no page.tsx calls requireContext() directly", () => {
    const offenders = pages.filter((f) => /\brequireContext\(/.test(code(f)));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("organisation pages say they need an organisation, platform pages a superadmin", () => {
    // A superadmin whose act-as visit lapsed still has a session and no
    // organisation; an organisation page would then throw from the first
    // service it called -- the same screen by another door.
    for (const f of pages) {
      const body = code(f);
      if (!/requirePageContext\(/.test(body)) continue;
      const rel = path.relative(ROOT, f).split(path.sep).join("/");
      if (rel.startsWith("(app)/")) {
        expect(body, rel).toMatch(/requirePageContext\(\{ org: true \}\)/);
      } else if (rel.startsWith("(platform)/")) {
        expect(body, rel).toMatch(/requirePageContext\(\{ superadmin: true \}\)/);
      }
    }
  });

  it("the helper redirects on a dead session and rethrows everything else", () => {
    const body = code(path.resolve("src/lib/auth/context.ts"));
    const start = body.indexOf("export async function requirePageContext");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    expect(block).toMatch(/if \(error instanceof UnauthorizedError\) redirect\("\/login"\)/);
    expect(block).toMatch(/throw error;/);
    expect(block).toMatch(/if \(needs\.org && !ctx\.organizationId\) redirect\(ctx\.isSuperadmin \? "\/platform" : "\/login"\)/);
    expect(block).toMatch(/if \(needs\.superadmin && !ctx\.isSuperadmin\) redirect\("\/dashboard"\)/);
  });
});

describe("every tree has a safety net, and the net checks the session first", () => {
  it("error boundaries exist for the app, the platform, the kiosk and the root", () => {
    for (const f of ["(app)/error.tsx", "(platform)/error.tsx", "kiosk/error.tsx", "error.tsx"]) {
      expect(statSync(path.join(ROOT, f)).isFile(), f).toBe(true);
      expect(code(path.join(ROOT, f)), f).toMatch(/FaultScreen/);
    }
  });

  it("the fault screen asks whether anybody is signed in before it says anything", () => {
    const body = code(path.resolve("src/components/layout/FaultScreen.tsx"));
    expect(body).toMatch(/fetch\("\/api\/auth\/session"/);
    expect(body).toMatch(/authenticated === false/);
    expect(body).toMatch(/window\.location\.assign\(signInHref\(\)\)/);
    // Never from a sign-in page, or a fault there would loop.
    expect(body).toMatch(/if \(isSignInPage\(\)\)/);
  });

  it("and its way back is a full navigation, not the segment that just failed", () => {
    const body = code(path.resolve("src/components/layout/FaultScreen.tsx"));
    expect(body).toMatch(/<a href=\{home\}>/);
    expect(body).not.toMatch(/<Link/);
  });
});

describe("a 401 from a fetch is a sign-in, not a toast", () => {
  it("api() sends the browser to the login screen", () => {
    const body = code(path.resolve("src/lib/client/api.ts"));
    expect(body).toMatch(/response\.status === 401/);
    expect(body).toMatch(/window\.location\.assign\(signInHref\(\)\)/);
    // Never from the login screen itself, or it would loop.
    expect(body).toMatch(/!isSignInPage\(\)/);
  });

  it("the login form takes the person back to where the session died, on this site only", () => {
    const body = code(path.resolve("src/app/(auth)/login/LoginForm.tsx"));
    expect(body).toMatch(/get\("next"\)/);
    // A backslash is a slash to the URL parser; the guard refuses it too.
    expect(body).toMatch(/\(\?!\[\\\/\\\\\]\)/);
  });
});

describe("a visit that ends, ends on the screen too", () => {
  it("the impersonation banner counts down and leaves at zero", () => {
    const body = code(path.resolve("src/components/layout/ImpersonationBanner.tsx"));
    expect(body).toMatch(/if \(m <= 0 && !ending\.current\)/);
    expect(body).toMatch(/fetch\("\/api\/platform\/impersonation", \{ method: "DELETE" \}\)/);
  });

  it("and the expiry travels from the token to the banner", () => {
    expect(code(path.resolve("src/lib/auth/impersonation.ts"))).toMatch(/expiresAt/);
    expect(code(path.resolve("src/app/(app)/layout.tsx"))).toMatch(/expiresAt: ctx\.impersonating\.expiresAt\.toISOString\(\)/);
  });
});
