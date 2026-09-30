import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { signInHrefFor } from "./signInHref";

/**
 * Two things the forgot-password screen got wrong.
 *
 * It promised every employee a code that is only ever minted for the Owner and
 * Admins, and left them typing guesses into a box that answered "not valid" --
 * the real route, HR resetting from the profile, was never mentioned. And from
 * an organisation's own door it bounced people to the unbranded `/login`.
 */

const FORM = "src/app/(auth)/forgot-password/ForgotPasswordForm.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("sign in goes back through the door the person came in by", () => {
  it("the tenant door for /o/<slug>/forgot-password", () => {
    expect(signInHrefFor("/o/acme/forgot-password")).toBe("/o/acme");
    expect(signInHrefFor("/o/acme-ltd/forgot-password/")).toBe("/o/acme-ltd");
  });

  it("the generic page otherwise", () => {
    expect(signInHrefFor("/forgot-password")).toBe("/login");
    expect(signInHrefFor(null)).toBe("/login");
    expect(signInHrefFor("/o/acme")).toBe("/login");
  });

  it("and the form uses it everywhere it used to say /login", () => {
    const body = code(FORM);
    expect(body).toMatch(/const signInHref = signInHrefFor\(usePathname\(\)\)/);
    expect(body).toMatch(/router\.push\(signInHref\)/);
    expect(body).toMatch(/href=\{signInHref\}/);
    expect(body).not.toMatch(/"\/login"/);
  });
});

describe("no code is promised to somebody who will never get one", () => {
  const body = code(FORM);

  it("asks who the account is for before requesting anything", () => {
    expect(body).toMatch(/Who is this account for\?/);
    expect(body).toMatch(/setPath\("code"\)/);
    expect(body).toMatch(/setPath\("hr"\)/);
  });

  it("the HR route is stated plainly, with no code form and no request", () => {
    const hr = /\{path === "hr" \? \(([\s\S]*?)\) : \(/.exec(body)?.[1] ?? "";
    expect(hr).toMatch(/Ask HR or an administrator/);
    expect(hr).toMatch(/temporary password/);
    expect(hr).not.toMatch(/id="otp"/);
    expect(hr).not.toMatch(/Request a reset/);
    // Enter in the email box still submits; the handler refuses for them.
    expect(body).toMatch(/if \(path !== "code"\) return;/);
  });

  it("the code step says which roles it is for", () => {
    expect(body).toMatch(/is an Owner or Admin account/);
    expect(body).toMatch(/No code is issued for any other role/);
  });
});
