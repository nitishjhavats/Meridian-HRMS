import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The slug-change warning describes what the code does.
 *
 * `organizationAtSlug` resolves an address an organisation has left behind
 * (see `lib/pastSlugs.test.ts`), and the past-slug table keeps it from being
 * handed to anybody else. The alert on the profile said the opposite -- the
 * old address would stop working and every handout and printed link would
 * need reissuing -- and a platform owner who believed it would have reissued
 * credentials to a whole company for nothing.
 */

const FORM = "src/app/(platform)/platform/organisations/[id]/OrganizationProfile.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the slug-change alert", () => {
  const form = code(FORM);
  const alert = form.slice(form.indexOf("{slugChanged ? ("), form.indexOf(") : null}", form.indexOf("{slugChanged ? (")));

  it("says the old address keeps working", () => {
    expect(alert).toMatch(/keeps working/);
    expect(alert).toMatch(/no other organisation/);
  });

  it("and no longer tells them to reissue everything", () => {
    expect(alert).not.toMatch(/not forwarded/);
    expect(alert).not.toMatch(/will need reissuing/);
    expect(alert).not.toMatch(/plain Broadmate/);
  });
});
