import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
  type SystemRole,
  effectivePermissions,
} from "@/lib/auth/permissions";
import { describePermission } from "./permissions";

/**
 * The one rule that makes this screen safe.
 *
 * Everything else here is a settings form. This is a settings form that hands
 * out authority in a payroll system, so the failure it has to be proof against
 * is not a typo — it is an HR Manager who cannot promote themselves directly and
 * settles for granting `payroll.finalize` to somebody junior instead.
 *
 * The check under test is deliberately expressed over the *outcome* of each
 * option rather than over the word "grant", and these tests are what stop that
 * becoming a distinction without a difference: clearing a revocation restores a
 * permission just as effectively as adding one, and the naive version of this
 * rule misses it entirely.
 */

const ORG_ROLES: SystemRole[] = ["ORG_OWNER", "ADMIN", "HR_MANAGER", "TEAM_LEAD", "TEAM_MEMBER"];

/** Platform permissions are never offered by the service, so never tested here. */
const GRANTABLE = PERMISSIONS.filter((p) => !p.startsWith("platform.")) as Permission[];

type Grants = { permission: string; granted: boolean }[];

/** The three states a row can already be in when somebody opens the screen. */
function statesFor(permission: Permission): Grants[] {
  return [[], [{ permission, granted: true }], [{ permission, granted: false }]];
}

/**
 * Two of these walk the whole matrix -- every actor role against every target
 * role against every grantable permission in every grant state -- and that is
 * the point of them: the bug they exist to catch is one combination out of
 * thousands. They take seconds, not milliseconds, and adding the MANAGER role
 * this round made them about a third slower again, because the walk is
 * quadratic in the number of roles.
 *
 * Vitest's default timeout is five seconds, which is sized for a unit test. The
 * slowest of these ran at 3.1 s on an idle machine and failed at five when the
 * machine was also compiling the app -- a green suite that goes red under load
 * and back to green on a retry teaches people to rerun rather than to look.
 * So the budget is stated here, generously, and it is a budget rather than a
 * default somebody has to guess at.
 */
const MATRIX_TIMEOUT_MS = 30_000;

describe("per-user permission grants", () => {
  it("never offers an option that would leave somebody holding what the actor does not", () => {
    for (const actorRole of ORG_ROLES) {
      const actor = effectivePermissions(actorRole, []);

      for (const targetRole of ORG_ROLES) {
        for (const permission of GRANTABLE) {
          for (const grants of statesFor(permission)) {
            const row = describePermission(targetRole, grants, permission, actor);

            for (const value of row.allowed) {
              if (!row.outcomes[value]) continue;
              expect(
                actor.has(permission),
                `${actorRole} could set ${permission} to "${value}" on a ${targetRole}, ending up with a permission they do not hold`,
              ).toBe(true);
            }
          }
        }
      }
    }
  }, MATRIX_TIMEOUT_MS);

  it("refuses to restore a permission by clearing a revocation the actor cannot give", () => {
    // An Admin who has had `attendance.override` taken away from them, looking
    // at an HR Manager whose role includes it and who has had it revoked too.
    // "Follow the role" would hand it straight back, so it is not on offer —
    // and this is the case a rule written around the word "grant" lets through.
    const actor = effectivePermissions("ADMIN", [
      { permission: "attendance.override", granted: false },
    ]);
    const row = describePermission(
      "HR_MANAGER",
      [{ permission: "attendance.override", granted: false }],
      "attendance.override",
      actor,
    );

    expect(row.fromRole).toBe(true);
    expect(row.override).toBe("revoke");
    expect(row.effective).toBe(false);
    expect(row.allowed).toEqual(["revoke"]);
    expect(row.restriction).toBeTruthy();
  });

  it("stops an HR Manager handing out payroll authority they were never given", () => {
    const actor = effectivePermissions("HR_MANAGER", []);
    const row = describePermission("TEAM_LEAD", [], "payroll.finalize", actor);

    expect(row.actorHolds).toBe(false);
    expect(row.allowed).not.toContain("grant");
    // Taking away is always allowed: it can only ever reduce what somebody has.
    expect(row.allowed).toContain("revoke");
  });

  it("lets an owner give away anything they hold, and only that", () => {
    const actor = effectivePermissions("ORG_OWNER", []);

    for (const permission of GRANTABLE) {
      const row = describePermission("HR_MANAGER", [], permission, actor);
      expect(row.allowed.includes("grant"), permission).toBe(actor.has(permission));
    }
  });

  it("shows the role default, the override and the result as three separate answers", () => {
    // `leave.approve.team` is in the Team Lead bundle and not in the Team
    // Member one, which is what makes it useful for showing all four shapes.
    const actor = effectivePermissions("ADMIN", []);

    const plain = describePermission("TEAM_MEMBER", [], "leave.approve.team", actor);
    expect([plain.fromRole, plain.override, plain.effective]).toEqual([false, null, false]);

    const given = describePermission(
      "TEAM_MEMBER",
      [{ permission: "leave.approve.team", granted: true }],
      "leave.approve.team",
      actor,
    );
    expect([given.fromRole, given.override, given.effective]).toEqual([false, "grant", true]);

    const taken = describePermission(
      "TEAM_LEAD",
      [{ permission: "leave.approve.team", granted: false }],
      "leave.approve.team",
      actor,
    );
    expect([taken.fromRole, taken.override, taken.effective]).toEqual([true, "revoke", false]);

    // An override that agrees with the role. It changes nothing today, and is
    // still worth showing: it outlives a change of role.
    const redundant = describePermission(
      "TEAM_LEAD",
      [{ permission: "leave.approve.team", granted: true }],
      "leave.approve.team",
      actor,
    );
    expect([redundant.fromRole, redundant.override, redundant.effective]).toEqual([
      true,
      "grant",
      true,
    ]);
  });

  it("agrees with the permission set the guards are actually built from", () => {
    // The screen must never claim somebody can do something the guard will
    // refuse. `effective` is asked of `effectivePermissions` for exactly that
    // reason, and this is the assertion that keeps it that way.
    const actor = effectivePermissions("ORG_OWNER", []);

    for (const role of ORG_ROLES) {
      for (const permission of GRANTABLE) {
        for (const grants of statesFor(permission)) {
          const row = describePermission(role, grants, permission, actor);
          expect(row.effective, `${role} ${permission}`).toBe(
            effectivePermissions(role, grants).has(permission),
          );
          expect(row.fromRole, `${role} ${permission}`).toBe(
            ROLE_PERMISSIONS[role].includes(permission),
          );
        }
      }
    }
  }, MATRIX_TIMEOUT_MS);
});
