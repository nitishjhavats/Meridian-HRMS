import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The icon a reception tablet installs itself under.
 *
 * "kiosk pwa ka v aisa hi rakho pwa icon jo organisation uska logo icon" — and
 * it did not. `/kiosk/manifest.webmanifest` called `buildManifest(null)`, so
 * every device in every company installed under Broadmate's mark rather than
 * the logo of the company whose reception it stands in.
 *
 * The cause is worth writing down because it is not obvious and it will be
 * rediscovered otherwise: **a manifest is fetched without credentials** unless
 * the `<link>` says `use-credentials`. So the route ran anonymously and could
 * not have read the device's session even though the device is signed in. The
 * organisation therefore travels in the URL, which `generateMetadata` puts
 * there — the slug is already in every tenant entry URL and is not a secret.
 */

const LAYOUT = "src/app/kiosk/layout.tsx";
const ROUTE = "src/app/kiosk/manifest.webmanifest/route.ts";
const BUILDER = "src/lib/manifest.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("a device installs under its own organisation's logo", () => {
  it("the layout puts the slug in the manifest URL", () => {
    const body = code(LAYOUT);
    expect(body).toMatch(/generateMetadata/);
    expect(body).toMatch(/manifest: `\/kiosk\/manifest\.webmanifest\$\{query\}`/);
  });

  it("and in the tab and home-screen icons, which never read the manifest", () => {
    const body = code(LAYOUT);
    expect(body).toMatch(/\/api\/branding\/icon\/192\$\{query\}/);
  });

  it("the route reads it rather than assuming nobody", () => {
    const body = code(ROUTE);
    expect(body).toMatch(/searchParams\.get\("org"\)/);
    expect(body).toMatch(/buildManifest\(slug, "kiosk"\)/);
    // The bug in one expression.
    expect(body).not.toMatch(/buildManifest\(null/);
  });
});

describe("and still opens the device screen when it is launched", () => {
  it("the kiosk variant starts at /kiosk, whatever slug it carries", () => {
    /**
     * The regression this round could have shipped. Naming a slug makes
     * `buildManifest` scope the install to `/o/<slug>`, which is the tenant
     * sign-in page: every reception tablet would have installed with the right
     * icon and opened the wrong screen.
     */
    const body = code(BUILDER);
    expect(body).toMatch(/variant === "kiosk" \? "\/kiosk"/);
  });
});
