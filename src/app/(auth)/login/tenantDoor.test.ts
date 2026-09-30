import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A tenant door keeps its organisation for the whole sign-in.
 *
 * `/o/<slug>` renders the login form with `tenant` set, which narrows the
 * candidate set so somebody whose email exists in two organisations is not
 * asked which one on a page that already says. The email box's change handler
 * reset the filter to nothing on the first keystroke, so the door forgot its
 * organisation before anybody had finished typing their address and the
 * "Choose your organisation" picker appeared anyway.
 */

const FORM = "src/app/(auth)/login/LoginForm.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the login route behind a tenant door", () => {
  const route = code("src/app/api/auth/login/route.ts");

  it("looks again without the organisation when the door finds nobody", () => {
    // The filter is a tie-breaker between two accounts with one address, not a
    // refusal of the platform owner (no organisation) or of somebody whose
    // account lives elsewhere.
    expect(route).toMatch(/candidates\.length === 0 && body\.organizationId/);
    expect(route).toMatch(/where: \{ email: body\.email \},/);
  });
});

describe("the email box on the login form", () => {
  const form = code(FORM);

  it("resets the organisation to the door's own, never to nothing", () => {
    expect(form).toMatch(/useState\(tenant\?\.id \?\? ""\)/);
    expect(form).toMatch(/setEmail\(e\.target\.value\);\s*setOrganizations\(null\);\s*setOrganizationId\(tenant\?\.id \?\? ""\);/);
    expect(form).not.toMatch(/setOrganizationId\(""\)/);
  });
});
