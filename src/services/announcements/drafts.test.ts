import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";

/**
 * Who can read an announcement nobody has published yet.
 *
 * An unpublished announcement is by definition something that is not meant to
 * have been seen. Drafts here are restructures, policy changes and pay news,
 * written days before they are sent.
 *
 * The feed used to collapse both posting permissions into one `canManage` flag
 * and show every draft in the organisation to anyone holding either — so every
 * team lead and manager could read the owner's unsent drafts, while the comment
 * directly above the filter claimed they saw "their own". Measured, not
 * deduced: an HR-authored draft was visible to a MANAGER and a TEAM_LEAD before
 * the change and to neither after, with the author and an ADMIN still seeing it.
 *
 * The split is deliberate rather than uniform. `announcement.create` is one
 * comms desk and sees the whole queue; `announcement.create.team` sees only
 * what it wrote.
 */

const SOURCE = readFileSync(path.resolve("src/services/announcements/index.ts"), "utf8");

describe("the draft queue is not shared with team-scoped posters", () => {
  it("keeps the two posting permissions apart", () => {
    // One flag for both is the bug. If these collapse again, so does the rule.
    expect(SOURCE).toMatch(/seesEveryDraft = ctx\.permissions\.has\("announcement\.create"\)/);
    expect(SOURCE).toMatch(/seesOwnDrafts = ctx\.permissions\.has\("announcement\.create\.team"\)/);
    expect(SOURCE).not.toMatch(/canManage/);
  });

  it("lets a team-scoped poster through only for their own rows", () => {
    expect(SOURCE).toMatch(/seesOwnDrafts && row\._authorId === ctx\.userId/);
  });

  it("does not leak the author id into the feed it returns", () => {
    // `_authorId` is carried only to make the decision above; a client that
    // could read it would learn who drafted things it cannot see.
    expect(SOURCE).toMatch(/\.map\(\(\{ _visible, _authorId, \.\.\.row \}\) => row\)/);
  });
});

describe("the roles this actually protects against", () => {
  it("is the roles that can post to a team but not organisation-wide", () => {
    for (const role of ["TEAM_LEAD", "MANAGER"] as const) {
      const held = ROLE_PERMISSIONS[role] as readonly string[];
      expect(held).toContain("announcement.create.team");
      expect(held).not.toContain("announcement.create");
    }
  });

  it("leaves the organisation-wide posters as they were", () => {
    for (const role of ["HR_MANAGER", "ADMIN", "ORG_OWNER"] as const) {
      expect(ROLE_PERMISSIONS[role] as readonly string[]).toContain("announcement.create");
    }
  });
});
