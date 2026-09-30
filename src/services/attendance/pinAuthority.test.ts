import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { ORG_NAV } from "@/lib/navigation";

/**
 * Who may hand out an attendance PIN, and how they get to the screen.
 *
 * A PIN marks attendance with no photo at all. Deciding who may issue one is
 * the access decision behind every face check, and until now it had no
 * permission key: the answer was `attendance.override` or a reporting line,
 * both in code, and the only place to do it was a widget on the employee
 * profile that somebody named on the PIN authority screen could not open.
 *
 * Now it is one permission. Owner and Admin hold it from the bundle; the
 * screen grants it by role, designation or person; the context folds those
 * rows in on load; and the tab, the page guard and the services all read the
 * same set.
 */

const AUTHORITY = "src/services/attendance/pinAuthority.ts";
const CONTEXT = "src/lib/auth/context.ts";
const KIOSK = "src/services/attendance/kiosk.ts";
const PROFILE = "src/app/(app)/employees/[id]/page.tsx";
const PANEL = "src/app/(app)/settings/attendance/PinAuthority.tsx";
const DESK = "src/app/(app)/attendance/pin/page.tsx";

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

describe("the permission, and who holds it out of the box", () => {
  it("Owner and Admin hold it; nobody below does by default", () => {
    // The owner's answer, asked directly: Owner + Admin on, everybody else by
    // their tick. HR manager included -- "sirf Owner + Admin".
    expect(ROLE_PERMISSIONS.ORG_OWNER).toContain("attendance.pin.issue");
    expect(ROLE_PERMISSIONS.ADMIN).toContain("attendance.pin.issue");
    for (const role of ["HR_MANAGER", "MANAGER", "SUPERVISOR", "TEAM_LEAD", "TEAM_MEMBER"] as const) {
      expect(ROLE_PERMISSIONS[role], role).not.toContain("attendance.pin.issue");
    }
  });

  it("and a shared device never does", () => {
    // A screen anybody can walk up to must not be able to issue its own bypass.
    expect(ROLE_PERMISSIONS.KIOSK).not.toContain("attendance.pin.issue");
    expect(bodyOf(AUTHORITY, "export async function mayIssuePin")).toMatch(/ctx\.role === "KIOSK"\) return false/);
  });

  it("correcting a day no longer implies issuing a PIN", () => {
    // Different powers. One rewrites a day after the fact; the other waves
    // somebody past the camera at the door.
    const body = bodyOf(AUTHORITY, "export async function mayIssuePin");
    expect(body).toMatch(/hasPermission\(ctx, "attendance\.pin\.issue"\)/);
    expect(body).not.toMatch(/attendance\.override/);
  });
});

describe("a row on the authority screen reaches the navigation", () => {
  it("the context folds role, designation and person rows into the permission set", () => {
    /**
     * Nav and page guards are synchronous checks of `ctx.permissions`; they
     * cannot ask the database. So the answer is computed once, on load, and
     * everything downstream reads one thing.
     */
    const body = code(CONTEXT);
    expect(body).toMatch(/prisma\.attendancePinAuthority\.findFirst/);
    expect(body).toMatch(/\{ role: user\.role \}/);
    expect(body).toMatch(/designationId: user\.employee\.designationId/);
    expect(body).toMatch(/employeeId: user\.employee\.id/);
    expect(body).toMatch(/if \(pinAuthority\) permissions\.add\("attendance\.pin\.issue"\)/);
  });

  it("but an explicit take-away on the person wins", () => {
    const body = code(CONTEXT);
    expect(body).toMatch(/g\.permission === "attendance\.pin\.issue" && !g\.granted/);
  });

  it("and the tab is gated on exactly that permission", () => {
    const people = ORG_NAV.find((s) => s.items.some((i) => i.href === "/attendance/pin"));
    const item = people?.items.find((i) => i.href === "/attendance/pin");
    expect(item).toBeDefined();
    expect(item?.permission).toBe("attendance.pin.issue");
    expect(item?.module).toBe("attendance");
  });

  it("as is the page, and its own roster", () => {
    expect(code(DESK)).toMatch(/permission: "attendance\.pin\.issue"/);
    // Not `listEmployees`: a ticked Team Member holds no `employee.read`, and
    // would be shown only themselves.
    expect(bodyOf(AUTHORITY, "export async function pinRoster")).toMatch(
      /requirePermission\(ctx, "attendance\.pin\.issue"\)/,
    );
  });

  it("the profile widget follows the same permission", () => {
    expect(code(PROFILE)).toMatch(/hasPermission\(ctx, "attendance\.pin\.issue"\)/);
    expect(code(PROFILE)).not.toMatch(/hasPermission\(ctx, "attendance\.override"\) \|\|/);
  });
});

describe("the roles the owner can tick", () => {
  it("Owner and Admin are on and locked, the device is not offered", () => {
    const body = code(AUTHORITY);
    expect(body).toMatch(/ALWAYS_ROLES: SystemRole\[\] = \["ORG_OWNER", "ADMIN"\]/);
    expect(body).toMatch(/GRANTABLE_ROLES: SystemRole\[\] = \["HR_MANAGER", "MANAGER", "TEAM_LEAD", "SUPERVISOR", "TEAM_MEMBER"\]/);
    expect(body).not.toMatch(/GRANTABLE_ROLES[^\n]*KIOSK/);
  });

  it("a grant is exactly one of role, designation or person", () => {
    const body = bodyOf(AUTHORITY, "export async function grantPinAuthority");
    expect(body).toMatch(/\[designationId, employeeId, role\]\.filter\(Boolean\)\.length !== 1/);
    expect(body).toMatch(/GRANTABLE_ROLES\.includes\(role\)/);
  });

  it("and the panel renders one switch per role", () => {
    const panel = code(PANEL);
    expect(panel).toMatch(/data\.roles\.map/);
    expect(panel).toMatch(/disabled=\{!canWrite \|\| r\.always \|\| busy\}/);
  });
});

describe("the list of who can help tells the truth", () => {
  it("names the permission holders, not only the designation and person rows", () => {
    /**
     * On every live organisation the owner could issue a PIN and the phone's
     * dialog said "Nobody has been given that power yet", because the list read
     * only the two kinds of row and never the role bundle.
     */
    const body = bodyOf(AUTHORITY, "export async function whoCanIssuePin");
    expect(body).toMatch(/\.\.\.ALWAYS_ROLES/);
    expect(body).toMatch(/role: \{ in: roles \}/);
    expect(body).toMatch(/permission: "attendance\.pin\.issue", granted: true/);
    expect(body).toMatch(/permission: "attendance\.pin\.issue", granted: false/);
  });
});

describe("nobody issues their own, whoever they are", () => {
  it("the self check comes before the authority check", () => {
    // It sat inside the else-branch of `mayIssuePin`, so an administrator
    // could issue themselves a way past their own face.
    const body = bodyOf(KIOSK, "export async function issueAttendancePin");
    expect(body.indexOf("if (forSelf)")).toBeGreaterThan(-1);
    expect(body.indexOf("if (forSelf)")).toBeLessThan(body.indexOf("await mayIssuePin(ctx)"));
  });

  it("and the desk's roster leaves the caller out", () => {
    expect(bodyOf(AUTHORITY, "export async function pinRoster")).toMatch(/NOT: \{ id: ctx\.employeeId \}/);
  });
});

describe("the PINs issued today can be seen", () => {
  it("everybody's by an administrator, one's own by anybody else", () => {
    const body = bodyOf(AUTHORITY, "export async function listRecentPins");
    expect(body).toMatch(/hasPermission\(ctx, "attendance\.settings\.manage"\)/);
    expect(body).toMatch(/\{ issuedById: ctx\.userId \}/);
  });
});
