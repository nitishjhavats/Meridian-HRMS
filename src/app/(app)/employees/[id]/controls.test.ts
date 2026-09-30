import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { EMPLOYEE_LOGIN_ROLES } from "@/domain/employees/loginRoles";
import { ROLE_PERMISSIONS, assignableRoles, canManageRole } from "@/lib/auth/permissions";

/**
 * The controls on an employee's profile are offered only where the API would
 * accept them.
 *
 * The six-role sweep clicked every button on this page as every role, and
 * four of them could only ever produce a toast saying no: "Resigned" for an
 * HR Manager, "Administrator" in the login picker for the same person, "Reset
 * password" on a peer's or your own profile, and the PIN widget for an HR
 * Manager on anybody outside their own reports -- and for anybody on their
 * own record. Each of these is a rule the service already applies; the page
 * has to apply the same one before it draws the button.
 */

const PROFILE = "src/app/(app)/employees/[id]/page.tsx";
const STATE = "src/app/(app)/employees/[id]/EmploymentState.tsx";
const LOGIN = "src/app/(app)/employees/[id]/LoginControls.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("changing state", () => {
  it("the leaving states really do need a permission the state-changers lack", () => {
    // If this ever stops being true the gating below is merely redundant, not
    // wrong -- but it is the reason the gating exists.
    for (const role of ["HR_MANAGER", "MANAGER"] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain("employee.state.change");
      expect(ROLE_PERMISSIONS[role]).not.toContain("employee.terminate");
    }
  });

  it("the page passes employee.terminate down", () => {
    expect(code(PROFILE)).toMatch(/canTerminate = hasPermission\(ctx, "employee\.terminate"\)/);
    expect(code(PROFILE)).toMatch(/<EmploymentState[\s\S]*?canTerminate=\{canTerminate\}/);
  });

  it("and the dialog disables the three leaving states without it, with a hint", () => {
    const dialog = code(STATE);
    expect(dialog).toMatch(/disabled=\{s\.value === current \|\| \(!canTerminate && LEAVING\.has\(s\.value\)\)\}/);
    expect(dialog).toMatch(/\(leaving && !canTerminate\)/);
    expect(dialog).toMatch(/exit module/);
  });
});

describe("logins", () => {
  it("the rank rule the credentials service applies is what the page mirrors", () => {
    // An HR Manager may hand out everything below HR; an Admin everything
    // below Admin. Nobody gets their own rank, so "self" falls out of the
    // same comparison.
    expect(assignableRoles("HR_MANAGER").filter((r) => EMPLOYEE_LOGIN_ROLES.includes(r as never)))
      .toEqual(["MANAGER", "TEAM_LEAD", "SUPERVISOR", "TEAM_MEMBER"]);
    expect(canManageRole("ADMIN", "ADMIN")).toBe(false);
    expect(canManageRole("ADMIN", "ORG_OWNER")).toBe(false);
    expect(canManageRole("ADMIN", "HR_MANAGER")).toBe(true);
  });

  it("the page works out the assignable roles server-side and passes them in", () => {
    const page = code(PROFILE);
    expect(page).toMatch(/assignableRoles\(ctx\.role\)\.filter\(isEmployeeLoginRole\)/);
    expect(page).toMatch(/<LoginControls[\s\S]*?assignableRoles=\{loginRoles\}/);
  });

  it("the picker offers only those", () => {
    const controls = code(LOGIN);
    expect(controls).toMatch(/EMPLOYEE_LOGIN_ROLE_LABELS\.filter\(\(r\) => assignableRoles\.includes\(r\.value\)\)/);
    expect(controls).toMatch(/\{roles\.map\(\(r\) =>/);
    expect(controls).not.toMatch(/\{EMPLOYEE_LOGIN_ROLE_LABELS\.map/);
  });

  it("reset password is offered only for somebody below you who is not you", () => {
    const page = code(PROFILE);
    expect(page).toMatch(
      /canResetPassword =\s*employee\.user != null && !isSelf && canManageRole\(ctx\.role, employee\.user\.role as SystemRole\)/,
    );
    expect(page).toMatch(/\{canEdit && \(!employee\.user \|\| canResetPassword\) \? \(\s*<LoginControls/);
  });
});

describe("the attendance PIN widget", () => {
  it("follows issueAttendancePin: the permission or the reporting line, never for yourself", () => {
    const page = code(PROFILE);
    expect(page).toMatch(
      /canIssuePin =\s*!isSelf &&\s*\(hasPermission\(ctx, "attendance\.pin\.issue"\) \|\| \(await teamEmployeeIds\(ctx\)\)\.includes\(id\)\)/,
    );
    expect(page).toMatch(/\{canIssuePin \? \(/);
    // `attendance.read.team` was the old gate, and it is not what the service
    // checks: an HR Manager holds it for everybody and can issue for nobody.
    expect(page).not.toMatch(/hasPermission\(ctx, "attendance\.read\.team"\)/);
  });
});
