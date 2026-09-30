import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";

/**
 * Who may ask about somebody else's face.
 *
 * A reference photo is biometric data about one identifiable person, and the
 * status object carries `photoKey` -- which `/api/files/[...key]` will serve to
 * anyone holding a session in the same tenant, by design, because a storage key
 * is not meant to be a secret.
 *
 * So the scope check on the *status* call is the only thing standing between a
 * team lead and every colleague's reference photo. It was missing: the function
 * checked that the caller holds `employee.read.team` and never checked *whose*
 * team, so `GET /api/employees/<anyone>/face` answered 200 for any employee in
 * the organisation. Measured, not deduced -- a MANAGER got 200 for an employee
 * whose detail page correctly returned 404 in the same session.
 *
 * These tests are cheap and blunt on purpose. The real proof was the request;
 * this is what stops it coming back.
 */

const SOURCE = readFileSync(path.resolve("src/services/employees/faceEnrolment.ts"), "utf8");

describe("reading somebody's enrolment is narrowed to people you may see", () => {
  it("asks visibleEmployeeIds, not just the permission", () => {
    const status = SOURCE.slice(SOURCE.indexOf("export async function getEnrolmentStatus"));
    expect(status).toMatch(/visibleEmployeeIds\(ctx, "employee\.read"\)/);
  });

  it("refuses with 404, so the answer does not confirm the person exists", () => {
    const status = SOURCE.slice(SOURCE.indexOf("export async function getEnrolmentStatus"));
    // `visible !== null` is the load-bearing half: null means *no restriction*,
    // and reading it as "nothing is visible" would lock out every admin. That
    // inversion has caused a finding in this project before.
    expect(status).toMatch(/visible !== null && !visible\.includes\(employeeId\)/);
    expect(status).toMatch(/throw new NotFoundError/);
  });
});

describe("changing somebody's enrolment stays with the roles that manage people", () => {
  it("needs employee.update, which team leads and managers do not hold", () => {
    // This is why only the read was exposed. If `assertMayEnrol` ever softens
    // to `employee.read.team`, a team lead could replace a colleague's
    // reference photo with their own face and mark that colleague present.
    expect(SOURCE).toMatch(/hasPermission\(ctx, "employee\.update"\)/);
    for (const role of ["TEAM_LEAD", "MANAGER", "TEAM_MEMBER"] as const) {
      expect(ROLE_PERMISSIONS[role] as readonly string[]).not.toContain("employee.update");
    }
  });

  it("still lets the roles that manage people do it", () => {
    for (const role of ["HR_MANAGER", "ADMIN", "ORG_OWNER"] as const) {
      expect(ROLE_PERMISSIONS[role] as readonly string[]).toContain("employee.update");
    }
  });
});
