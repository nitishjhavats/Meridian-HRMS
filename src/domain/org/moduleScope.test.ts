import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { overridesFrom, scopedModules } from "./moduleScope";
import type { ModuleKey } from "@/lib/features";

const ORG = new Set<ModuleKey>(["attendance", "leave", "payroll", "chat", "reimbursements"]);

describe("scopedModules", () => {
  it("gives everything the organisation has when nothing is overridden", () => {
    expect(scopedModules({ organisation: ORG })).toEqual(ORG);
  });

  it("lets a designation take one away from everybody holding it", () => {
    const result = scopedModules({ organisation: ORG, designation: { chat: false } });
    expect(result.has("chat")).toBe(false);
    expect(result.has("leave")).toBe(true);
  });

  it("lets one person keep what their designation lost", () => {
    // The case that makes both layers necessary: chat off for the shop floor,
    // and on for the one supervisor who coordinates it.
    const result = scopedModules({
      organisation: ORG,
      designation: { chat: false },
      user: { chat: true },
    });
    expect(result.has("chat")).toBe(true);
  });

  it("lets one person lose what their designation kept", () => {
    const result = scopedModules({
      organisation: ORG,
      designation: { chat: true },
      user: { chat: false },
    });
    expect(result.has("chat")).toBe(false);
  });

  it("never adds a module the organisation does not have", () => {
    // The load-bearing rule. Without it an administrator could hand one person
    // a module the company is not paying for, from a screen whose whole subject
    // is that person.
    const result = scopedModules({
      organisation: ORG,
      designation: { assets: true },
      user: { onboarding: true, exit: true },
    });
    expect(result.has("assets")).toBe(false);
    expect(result.has("onboarding")).toBe(false);
    expect(result.has("exit")).toBe(false);
    expect(result).toEqual(ORG);
  });

  it("does not mind an override for something already absent", () => {
    const result = scopedModules({ organisation: ORG, user: { assets: false } });
    expect(result).toEqual(ORG);
  });

  it("leaves the organisation set untouched", () => {
    // It is the caller's set, and it is read on every request.
    const before = new Set(ORG);
    scopedModules({ organisation: ORG, user: { chat: false } });
    expect(ORG).toEqual(before);
  });

  it("is empty when the organisation has nothing", () => {
    expect(scopedModules({ organisation: new Set(), user: { chat: true } }).size).toBe(0);
  });
});

describe("overridesFrom", () => {
  const known = new Set<string>(["chat", "leave", "payroll"]);

  it("turns rows into a lookup", () => {
    expect(
      overridesFrom(
        [
          { moduleKey: "chat", enabled: false },
          { moduleKey: "leave", enabled: true },
        ],
        known,
      ),
    ).toEqual({ chat: false, leave: true });
  });

  it("drops a row for a module that no longer exists", () => {
    // A module removed from the registry leaves its rows behind. Carrying them
    // would make this function's output claim an effect it cannot have.
    expect(overridesFrom([{ moduleKey: "telepathy", enabled: false }], known)).toEqual({});
  });

  it("handles no rows", () => {
    expect(overridesFrom([], known)).toEqual({});
  });
});

/** Pinning a pure function does not pin its caller. */
describe("the auth context uses it", () => {
  it("layers the two override tables through this module", () => {
    const source = readFileSync("src/lib/auth/context.ts", "utf8");
    expect(source).toContain("scopedModules");
    expect(source).toContain("overridesFrom");
  });
});
