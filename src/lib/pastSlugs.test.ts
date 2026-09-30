import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * An address an organisation has left behind still answers for it.
 *
 * `/o/<slug>` is not just a link. It is printed on emails, it is what people
 * bookmark, and it is baked into the start URL of every installed PWA — so a
 * rename stranded all three at once. The old address went on loading, resolved
 * to nobody, and served the product's own name and icon in place of the
 * company's; a signed-in employee who arrived there was told they were signed
 * in somewhere else.
 *
 * It is *resolved*, not redirected, and that is the part worth guarding. A
 * redirect would move the browser to the new address, and an installed app
 * whose manifest is re-fetched from a URL that redirects is an app whose
 * identity the browser may decide has changed — which is exactly the
 * re-install this was meant to avoid.
 */

const BRANDING = "src/lib/branding.ts";
const ORGS = "src/services/platform/organizations.ts";
const TENANT_PAGE = "src/app/o/[slug]/page.tsx";
const SCHEMA = "prisma/schema.prisma";

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("an old address resolves to the organisation that left it", () => {
  it("the resolver falls back to the history", () => {
    const block = bodyOf(BRANDING, "async function organizationAtSlug");
    expect(block).toMatch(/organizationSlug\.findUnique/);
  });

  it("only after the current slug misses, so the common path costs nothing", () => {
    const block = bodyOf(BRANDING, "async function organizationAtSlug");
    expect(block.indexOf("organization.findFirst")).toBeLessThan(
      block.indexOf("organizationSlug.findUnique"),
    );
    expect(block).toMatch(/if \(current\) return current;/);
  });

  it("and a suspended organisation is still refused through it", () => {
    // The current-slug query filters on status. The history query has to as
    // well, or a suspended company's old address would be the one door left
    // open.
    const block = bodyOf(BRANDING, "async function organizationAtSlug");
    expect(block).toMatch(/status === "SUSPENDED"/);
  });

  it("hands back the current slug, never the one that was asked for", () => {
    /**
     * Everything downstream builds links and icon URLs out of what this
     * returns. Returning the old slug would keep it alive for ever and put it
     * back into circulation on pages that had moved on.
     */
    const block = bodyOf(BRANDING, "async function organizationAtSlug");
    expect(block).toMatch(/const \{ status: _status, \.\.\.org \} = past\.organization;/);
  });

  it("the logo and icon route goes through the same resolver", () => {
    // The installed app asks for its icon with the slug its manifest was
    // fetched under, which is the old one.
    const block = bodyOf(BRANDING, "export async function publicLogoKeyForSlug");
    expect(block).toMatch(/organizationAtSlug\(slug\)/);
    expect(block).not.toMatch(/organization\.findFirst/);
  });

  it("and nothing redirects", () => {
    // A redirect would change the address in the bar and re-point the manifest,
    // which is the thing this avoids.
    expect(code(BRANDING)).not.toMatch(/\bredirect\(/);
  });
});

describe("a member arriving on an old address is let through", () => {
  it("compared by id, not against the slug in the URL", () => {
    // They were told "you are signed in somewhere else" at their own company.
    const page = code(TENANT_PAGE);
    expect(page).toMatch(/ctx\.organization\?\.id === organization\.id/);
    expect(page).not.toMatch(/ctx\.organization\?\.slug === slug/);
  });
});

describe("an address is never handed to a second organisation", () => {
  it("the slug gate checks the history as well as the current slugs", () => {
    const block = bodyOf(ORGS, "export async function normaliseSlug");
    expect(block).toMatch(/organizationSlug\.findUnique/);
    expect(block).toMatch(/previous\.organizationId !== options\.exceptOrganizationId/);
  });

  it("and the database refuses it too", () => {
    // The check above is the message a person reads; the index is what makes it
    // true under a race.
    const schema = source(SCHEMA);
    const start = schema.indexOf("model OrganizationSlug {");
    expect(start, "no past-slug model").toBeGreaterThan(-1);
    const block = schema.slice(start, schema.indexOf("\n}", start));
    expect(block).toMatch(/slug\s+String\s+@unique/);
  });
});

describe("moving is recorded with the move", () => {
  it("in the same transaction", () => {
    /**
     * Outside it, a failure halfway leaves an organisation at a new address
     * with nothing remembering the old one — and the old one is what is printed
     * on the emails already sent.
     */
    const block = bodyOf(ORGS, "export async function updateOrganization");
    const tx = block.indexOf("prisma.$transaction");
    const write = block.indexOf("organizationSlug.createMany");
    const update = block.indexOf("organization.update");
    expect(tx).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(tx);
    expect(write).toBeLessThan(update);
  });

  it("only when the slug actually changes", () => {
    const block = bodyOf(ORGS, "export async function updateOrganization");
    expect(block).toMatch(/orgPatch\.slug !== before\.slug/);
  });

  it("and renaming back to an old address clears it from the history", () => {
    // Otherwise the history would claim a slug the organisation is living at,
    // and the gate would refuse the organisation its own address.
    const block = bodyOf(ORGS, "export async function updateOrganization");
    expect(block).toMatch(/organizationSlug\.deleteMany\(\{ where: \{ organizationId, slug: orgPatch\.slug \} \}\)/);
  });
});
