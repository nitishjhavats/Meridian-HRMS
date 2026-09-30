import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The forced change-password screen has a way out that is not a password.
 *
 * Forced, it hides Cancel -- rightly, a one-time password is not a password.
 * But it offered no sign-out, and `/login` sent a signed-in session to its
 * landing page, whose layout sent it straight back here. Somebody who signed
 * in with a temporary password on the wrong device, or an admin trying a new
 * login on their own machine, was held until they chose a password they did
 * not want or cleared their cookies.
 */

const FORM = "src/app/(auth)/change-password/ChangePasswordForm.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the forced variant", () => {
  const form = code(FORM);

  it("still hides Cancel, and shows a sign-out in its place", () => {
    const tail = form.slice(form.indexOf("{!forced ? ("));
    expect(tail).toMatch(/<Link href=\{returnTo\}>Cancel<\/Link>/);
    expect(tail).toMatch(/\) : \(\s*<Button[\s\S]*onClick=\{\(\) => void signOut\(\)\}/);
    expect(tail).not.toMatch(/\) : null\}\s*<\/form>/);
  });

  it("revokes the session server-side and lands on the login page", () => {
    expect(form).toMatch(/fetch\("\/api\/auth\/logout", \{ method: "POST" \}\)/);
    // A full navigation: the login page is a server component that read the
    // cookie this just revoked, and it has to read again to show the form.
    // The organisation's own door when there is one; the route's answer when
    // it knows better (a support visit ends at the console).
    expect(form).toMatch(/answer\.redirectTo !== "\/login" \? answer\.redirectTo : signOutTo/);
    expect(code("src/app/(auth)/change-password/page.tsx")).toMatch(
      /signOutTo=\{ctx\.organization\?\.slug \? `\/o\/\$\{ctx\.organization\.slug\}` : "\/login"\}/,
    );
  });
});
