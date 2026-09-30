import { describe, expect, it } from "vitest";

import type { ModuleKey } from "./features";
import { ORG_NAV, type NavItem, canReach, isActive, visibleNav } from "./navigation";

/**
 * Two screens that existed and could not be reached.
 *
 * `/payroll` admits `payroll.read.team` and narrows its figures to the holder's
 * reports, and the permissions screen sells the key as "See their team's pay";
 * the sidebar asked for `.all` only, so a Team Lead had no way there but the
 * address bar. `/chat/reports` was reachable only from the notification a
 * report raises, and once that was read the page was gone.
 */

function ctx(permissions: string[], modules: ModuleKey[]) {
  return { permissions: new Set(permissions), modules: new Set<ModuleKey>(modules) };
}

function hrefs(permissions: string[], modules: ModuleKey[]): string[] {
  return visibleNav(ORG_NAV, ctx(permissions, modules)).flatMap((s) => s.items.map((i) => i.href));
}

describe("a team lead can reach the payroll page built for them", () => {
  it("shows Payroll runs for payroll.read.team", () => {
    expect(hrefs(["payroll.read.team"], ["payroll"])).toContain("/payroll");
  });

  it("still shows it for payroll.read.all", () => {
    expect(hrefs(["payroll.read.all"], ["payroll"])).toContain("/payroll");
  });

  it("and not when the module is off for them, or for a self-only reader", () => {
    expect(hrefs(["payroll.read.team"], [])).not.toContain("/payroll");
    expect(hrefs(["payroll.read.self"], ["payroll"])).not.toContain("/payroll");
  });
});

describe("reported conversations have a way in", () => {
  it("is listed for chat.export, under the chat module", () => {
    expect(hrefs(["chat.export"], ["chat"])).toContain("/chat/reports");
  });

  it("is not offered to somebody the page would refuse", () => {
    // HR holds chat.use and, by default, not chat.export -- the page's guard.
    expect(hrefs(["chat.use"], ["chat"])).not.toContain("/chat/reports");
    expect(hrefs(["chat.export"], [])).not.toContain("/chat/reports");
  });

  it("lights one sidebar entry on /chat/reports, not two", () => {
    const items = ORG_NAV.flatMap((s) => s.items);
    const chat = items.find((i) => i.href === "/chat")!;
    const reports = items.find((i) => i.href === "/chat/reports")!;
    expect(isActive("/chat/reports", chat)).toBe(false);
    expect(isActive("/chat/reports", reports)).toBe(true);
    // A thread is `/chat?with=`, which the exact match still counts as chat.
    expect(isActive("/chat", chat)).toBe(true);
  });
});

describe("canReach is the rule the sidebar filters with", () => {
  // Exported for the dashboard's tiles, which used to keep their own copy.
  it("decides every entry the way visibleNav does", () => {
    const viewer = ctx(["payroll.read.team", "chat.use", "employee.read.self"], ["payroll", "chat"]);
    const listed = new Set(hrefs([...viewer.permissions], [...viewer.modules]));
    for (const item of ORG_NAV.flatMap((s) => s.items)) {
      expect(canReach(item, viewer), item.href).toBe(listed.has(item.href));
    }
  });

  it("needs the module when one is named, and any one permission of several", () => {
    const either: Pick<NavItem, "permission" | "module"> = {
      permission: ["payroll.read.all", "payroll.read.team"],
      module: "payroll",
    };
    expect(canReach(either, ctx(["payroll.read.team"], ["payroll"]))).toBe(true);
    expect(canReach(either, ctx(["payroll.read.team"], []))).toBe(false);
    expect(canReach({ permission: "audit.read" }, ctx([], []))).toBe(false);
    expect(canReach({}, ctx([], []))).toBe(true);
  });
});
