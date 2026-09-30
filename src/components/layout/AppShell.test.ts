import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The red "trial has ended" banner is on every page for everybody, and its
 * "Go to billing" link went to a page that refuses anybody without
 * `org.billing.manage` -- so an employee was told to go somewhere they could
 * not. They are now told the one thing they can do instead.
 */

const SHELL = "src/components/layout/AppShell.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The access banner, from its condition to the end of its block. */
function banner(): string {
  const body = code(SHELL);
  const start = body.indexOf('accessState === "TRIAL_EXPIRED" || accessState === "PAST_DUE"');
  expect(start, "no access banner").toBeGreaterThan(-1);
  return body.slice(start, body.indexOf(": null}", start));
}

describe("the access banner", () => {
  it("offers billing only to somebody the billing page will admit", () => {
    const block = banner();
    expect(block).toMatch(/ctx\.permissions\.has\("org\.billing\.manage"\)\s*\?/);
    // The link sits inside that condition, not beside it.
    expect(block.indexOf('permissions.has("org.billing.manage")')).toBeLessThan(
      block.indexOf('href="/billing"'),
    );
  });

  it("and tells everybody else what they can do", () => {
    expect(banner()).toMatch(/Ask your administrator to renew\./);
  });
});
