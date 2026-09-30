import { describe, expect, it } from "vitest";
import { SystemRole as DbSystemRole } from "@prisma/client";
import {
  effectivePermissions,
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  ROLE_RANK,
  resolveScope,
  type Permission,
  type SystemRole,
} from "./permissions";

/**
 * Derived, not hand-written.
 *
 * This list used to be typed out, which meant that adding a role and forgetting
 * this file left the suite green while the new role was untested -- the exact
 * failure the file exists to catch.
 */
const ROLES = Object.keys(ROLE_RANK) as SystemRole[];

describe("the role tables agree with each other", () => {
  /**
   * The one that matters most.
   *
   * `SystemRole` in this file is a hand-written union with no link to Prisma's
   * generated enum. Add a role to the database and forget the union and there
   * is no compile error: `ROLE_PERMISSIONS[role]` is `undefined`,
   * `new Set(undefined)` is empty, and the person signs in to a product that
   * politely tells them they have no permission for anything.
   */
  it("holds exactly the roles the database does", () => {
    expect(Object.keys(DbSystemRole).sort()).toEqual(Object.keys(ROLE_RANK).sort());
  });

  /**
   * The invariant that makes inserting a tier safe.
   *
   * The sets are cumulative, so a permission added to a middle tier is
   * inherited by everybody above it. MANAGER sits between HR Manager and Team
   * Lead: if it ever adds something HR Manager did not already have, it has
   * quietly widened HR Manager, Admin and Owner too.
   */
  it("never widens a senior role by adding to a junior one", () => {
    const chain: SystemRole[] = ["TEAM_MEMBER", "TEAM_LEAD", "MANAGER", "HR_MANAGER", "ADMIN", "ORG_OWNER"];
    for (let i = 1; i < chain.length; i++) {
      const junior = new Set(ROLE_PERMISSIONS[chain[i - 1]!]);
      const senior = new Set(ROLE_PERMISSIONS[chain[i]!]);
      for (const permission of junior) {
        expect(senior.has(permission), `${chain[i]} is missing ${permission}`).toBe(true);
      }
      expect(senior.size, `${chain[i]} should be at least as wide as ${chain[i - 1]}`)
        .toBeGreaterThanOrEqual(junior.size);
    }
  });

  it("orders the enum the way it ranks the roles", () => {
    // `findApprover` falls back on the enum's declaration order, so the two
    // agreeing is not cosmetic. Kiosk is excluded: it is not a person and is
    // deliberately ranked below everybody rather than beside them.
    const byRank = (Object.keys(ROLE_RANK) as SystemRole[])
      .filter((r) => r !== "KIOSK")
      .sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);
    const byEnum = Object.keys(DbSystemRole).filter((r) => r !== "KIOSK");
    expect(byEnum).toEqual(byRank);
  });

  it("gives every role a label, a rank and a permission set", () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
      expect(typeof ROLE_RANK[role], role).toBe("number");
      expect(ROLE_PERMISSIONS[role], role).toBeDefined();
    }
  });

  it("only grants permissions that exist", () => {
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS, `${role} holds an unknown permission`).toContain(permission);
      }
    }
  });
});

/**
 * The kiosk is the one account in this product that acts for other people, on a
 * screen nobody is watching. Everything below is the argument that it cannot do
 * anything else, so each of these is a security test rather than a unit test.
 */
describe("the office device", () => {
  const kiosk = effectivePermissions("KIOSK");

  it("holds exactly two permissions", () => {
    expect([...kiosk].sort()).toEqual(["attendance.kiosk.operate", "attendance.mark.kiosk"]);
  });

  it("cannot read anybody's pay, documents or leave", () => {
    for (const forbidden of [
      "payroll.read.self",
      "payroll.read.all",
      "employee.salary.read",
      "document.read.self",
      "document.read.all",
      "leave.read.self",
      "employee.read.all",
      "audit.read",
      "notification.read",
    ] as Permission[]) {
      expect(kiosk.has(forbidden), forbidden).toBe(false);
    }
  });

  it("cannot mark attendance as itself, only for a named employee", () => {
    expect(kiosk.has("attendance.mark.self")).toBe(false);
  });

  it("cannot override or regularise a day", () => {
    expect(kiosk.has("attendance.override")).toBe(false);
    expect(kiosk.has("attendance.regularise.approve")).toBe(false);
  });

  it("holds no platform permission", () => {
    expect([...kiosk].some((p) => p.startsWith("platform."))).toBe(false);
  });

  // The barrier that matters most: a per-user grant is exactly the mechanism
  // that would widen this set on a device left in a reception.
  it("ignores per-user grants entirely", () => {
    const widened = effectivePermissions("KIOSK", [
      { permission: "payroll.read.all", granted: true },
      { permission: "employee.salary.read", granted: true },
      { permission: "platform.org.read", granted: true },
      { permission: "attendance.override", granted: true },
    ]);
    expect([...widened].sort()).toEqual(["attendance.kiosk.operate", "attendance.mark.kiosk"]);
  });

  it("cannot have its own two permissions revoked by a grant either", () => {
    const narrowed = effectivePermissions("KIOSK", [
      { permission: "attendance.mark.kiosk", granted: false },
    ]);
    expect(narrowed.has("attendance.mark.kiosk")).toBe(true);
  });

  it("resolves no scope for any family, because it reads nothing", () => {
    expect(resolveScope(kiosk, "employee.read")).toBeNull();
    expect(resolveScope(kiosk, "attendance.read")).toBeNull();
    expect(resolveScope(kiosk, "payroll.read")).toBeNull();
  });

  it("ranks below every person", () => {
    for (const role of ROLES) {
      if (role === "KIOSK") continue;
      expect(ROLE_RANK.KIOSK, role).toBeGreaterThan(ROLE_RANK[role]);
    }
  });

  // Nobody else should be able to do the kiosk's job by accident.
  it("is the only role holding the kiosk permissions", () => {
    for (const role of ROLES) {
      if (role === "KIOSK") continue;
      const set = effectivePermissions(role);
      expect(set.has("attendance.mark.kiosk"), role).toBe(false);
      expect(set.has("attendance.kiosk.operate"), role).toBe(false);
    }
  });
});

describe("grants elsewhere still behave", () => {
  it("lets a grant add a permission to an ordinary role", () => {
    const set = effectivePermissions("TEAM_MEMBER", [
      { permission: "report.export", granted: true },
    ]);
    expect(set.has("report.export")).toBe(true);
  });

  it("refuses to hand an org user a platform permission", () => {
    const set = effectivePermissions("ADMIN", [
      { permission: "platform.org.create", granted: true },
    ]);
    expect(set.has("platform.org.create")).toBe(false);
  });
});
