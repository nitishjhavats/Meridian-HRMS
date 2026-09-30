import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { effectivePermissions } from "@/lib/auth/permissions";

/**
 * "A conversation has been reported" went to HR with a link to a page that
 * refuses HR.
 *
 * `/chat/reports` is gated on `chat.export`, which is Admin's and above by
 * default; the notification went to HR_MANAGER, ADMIN and ORG_OWNER alike with
 * the same link. HR is still told -- the report dialog promises that -- but
 * the link now goes only to the people the page will admit, and that is
 * decided by effective permissions, because a grant row can hand
 * `chat.export` to anybody.
 */

const SERVICE = "src/services/chat/index.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function report(): string {
  const source = code(SERVICE);
  const start = source.indexOf("export async function reportConversation(");
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\nexport ", start + 1));
}

describe("the report notification", () => {
  const body = report();

  it("no longer sends one link to every role", () => {
    expect(body).not.toMatch(/notify\.toOrgRoles\(/);
  });

  it("links only the people who hold chat.export", () => {
    expect(body).toMatch(/effectivePermissions\(u\.role, u\.permissionGrants\)\.has\("chat\.export"\)/);
    expect(body).toMatch(/canOpen\.map\(\(u\) => u\.id\),\s*\{ \.\.\.notice, link: "\/chat\/reports" \}/);
    // The others get the notice with no link at all, not a link that refuses.
    expect(body).toMatch(/cannot\.map\(\(u\) => u\.id\),\s*notice,/);
  });

  it("still tells HR", () => {
    expect(body).toMatch(/role: \{ in: \["HR_MANAGER", "ADMIN", "ORG_OWNER"\] \}/);
  });

  it("which by default means Admins and the Owner get the link and HR does not", () => {
    expect(effectivePermissions("ADMIN").has("chat.export")).toBe(true);
    expect(effectivePermissions("ORG_OWNER").has("chat.export")).toBe(true);
    expect(effectivePermissions("HR_MANAGER").has("chat.export")).toBe(false);
    // And a grant changes the answer, which is why the split is not by role.
    expect(
      effectivePermissions("HR_MANAGER", [{ permission: "chat.export", granted: true }]).has("chat.export"),
    ).toBe(true);
  });
});
