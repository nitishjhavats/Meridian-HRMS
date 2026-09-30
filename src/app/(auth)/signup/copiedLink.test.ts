import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * "Copy the sign-in link" copies something an employee can be sent.
 *
 * The success panel after sign-up says the link is what the owner gives every
 * employee they add. The copied text named the owner's own email and told the
 * reader to "use the password you were given" -- which described nobody: the
 * owner had just chosen their own password, and the employees did not exist
 * yet. Forwarded to WhatsApp as it was, it confused the people it was for.
 */

const FORM = "src/app/(auth)/signup/SignUpForm.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the copied sign-in text", () => {
  const form = code(FORM);
  const start = form.indexOf("void copyText(");
  const copied = form.slice(start, form.indexOf('"Sign-in link copied"', start));

  it("carries the address and speaks to the employee", () => {
    expect(copied).toMatch(/\$\{created\.signInUrl\}/);
    expect(copied).toMatch(/temporary password your administrator gives you/);
  });

  it("does not carry the owner's email or a password nobody was given", () => {
    expect(copied).not.toMatch(/created\.email/);
    expect(copied).not.toMatch(/password you were given/);
  });

  it("while the owner still sees their own email on the screen", () => {
    expect(form).toMatch(/Your own sign-in[\s\S]*\{created\.email\}/);
  });
});
