import { describe, expect, it } from "vitest";
import * as chat from "./index";
import * as chatExport from "./export";
import * as retention from "./retention";
import { TABLES } from "@/services/export/tables";
import { RATE_LIMITS } from "@/lib/ratelimit";
import { PERMISSIONS, ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { MODULES } from "@/lib/features";

/**
 * The promises chat makes, asserted rather than commented.
 *
 * These are unusual tests — checking an export surface, a table list, a rate
 * limit constant — and they are the right ones. Each protects a decision that
 * is invisible in the code it guards: the absence of a function, the absence of
 * a table from a list, the presence of a name in a set. All of them would be
 * easy to undo by accident and hard to notice afterwards.
 */

describe("nothing deletes a message", () => {
  it("exports no function that could", () => {
    // Stronger than a permission check, which is one UserPermissionGrant row
    // away from being satisfied. If somebody adds `deleteMessage`, this fails
    // at review with a message explaining why it should not exist.
    const surface = [...Object.keys(chat), ...Object.keys(chatExport)];
    expect(surface.filter((name) => /delete|remove|redact|edit/i.test(name))).toEqual([]);
  });

  it("keeps the age-out as the only removal, and names it plainly", () => {
    expect(typeof retention.purgeExpiredChatMessages).toBe("function");
    expect(retention.CHAT_RETENTION_DAYS).toBe(30);
  });
});

describe("chat stays out of the organisation-wide export", () => {
  it("is not one of the exported tables", () => {
    // That file is downloaded by an organisation's owner under a permission
    // described to them as "your data". It must not be the thing that hands
    // them every private conversation in the company.
    const exported = TABLES.map((t) => t.model);
    for (const model of ["chatThread", "chatMessage", "chatBlock", "chatReport"]) {
      expect(exported, model).not.toContain(model);
    }
  });
});

describe("the fifty-a-day cap", () => {
  it("is fifty", () => {
    expect(RATE_LIMITS.chatMessage.limit).toBe(50);
  });

  it("has a window longer than a day, because the key carries the date", () => {
    // The window only stops a spent counter outliving its day. What makes it a
    // calendar day rather than a rolling twenty-four hours is that the key is
    // `<employee>:<YYYY-MM-DD>` in the organisation's timezone.
    expect(RATE_LIMITS.chatMessage.windowSeconds).toBeGreaterThan(86_400);
  });
});

describe("permissions", () => {
  it("gives everybody chat.use, so it can be taken from one person", () => {
    expect(PERMISSIONS).toContain("chat.use");
    expect(ROLE_PERMISSIONS.TEAM_MEMBER).toContain("chat.use");
  });

  it("keeps the export with Admins and above, and away from HR", () => {
    expect(ROLE_PERMISSIONS.ADMIN).toContain("chat.export");
    expect(ROLE_PERMISSIONS.ORG_OWNER).toContain("chat.export");
    expect(ROLE_PERMISSIONS.HR_MANAGER).not.toContain("chat.export");
    expect(ROLE_PERMISSIONS.MANAGER).not.toContain("chat.export");
  });

  it("never gives an office device a way into somebody's messages", () => {
    // KIOSK is not built on TEAM_MEMBER and takes no per-user grants, so this
    // is free — but it is the kind of free that stops being true silently.
    expect(ROLE_PERMISSIONS.KIOSK).not.toContain("chat.use");
    expect(ROLE_PERMISSIONS.KIOSK).not.toContain("chat.export");
  });

  it("has no organisation-wide read permission at all", () => {
    // Its existence would invite an admin read path. A conversation is readable
    // one pair at a time, with a reason, and both people are told.
    expect(PERMISSIONS).not.toContain("chat.read.all");
  });
});

describe("the module", () => {
  it("is on, and can be switched off", () => {
    // It used to ship off, which is why the chat icon never appeared beside
    // Announcements: the nav entry existed and the module behind it did not.
    // Off is still reachable -- organisation-wide, by designation, or for one
    // person -- and `chat.use` remains the finest lever of all.
    const chatModule = MODULES.find((m) => m.key === "chat");
    expect(chatModule).toBeDefined();
    expect(chatModule!.defaultEnabled).toBe(true);
    expect(chatModule!.core).toBe(false);
  });
});
