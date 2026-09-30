import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Sign out first" comes with a sign-out.
 *
 * Signed in at organisation A and opening B's door, a person was told to sign
 * out first and offered only "Go to your own dashboard" -- the one place the
 * sign-out is not. The screen now carries a button that revokes the session
 * through the same route the shell uses and reloads the door, signed out.
 */

const PAGE = "src/app/o/[slug]/page.tsx";
const BUTTON = "src/app/o/[slug]/SignOutHere.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the signed-in-elsewhere screen", () => {
  it("offers the sign-out beside the instruction", () => {
    const page = code(PAGE);
    const screen = page.slice(page.indexOf("You are signed in somewhere else"));
    expect(screen).toMatch(/<SignOutHere slug=\{slug\} \/>/);
    expect(screen).toMatch(/Go to your own dashboard/);
  });

  it("revokes the session server-side and comes back to this door", () => {
    const button = code(BUTTON);
    expect(button).toMatch(/fetch\("\/api\/auth\/logout", \{ method: "POST" \}\)/);
    // A full reload, not the router: the door is a server component that
    // read the cookie this just revoked.
    // Back to this door -- unless the route says otherwise, which it does for
    // a superadmin ending a support visit (they stay signed in as themselves).
    expect(button).toMatch(/answer\.redirectTo !== "\/login" \? answer\.redirectTo : `\/o\/\$\{slug\}`/);
    expect(button).not.toMatch(/useRouter/);
  });
});
