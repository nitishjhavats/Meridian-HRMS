import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The dashboard must never reach the error boundary.
 *
 * It is where sign-in lands, and every denied screen -- and the error screen
 * itself -- offers only "Back to the dashboard". So a throw here is not one
 * broken page; it is a person with no working page in the app at all. Two
 * revocations an admin can make from the permissions screen used to do that:
 * "See their own record" (`scopeFor` threw on an absent `employee.read`
 * scope) and "See their own attendance" (`getMonthlyGrid` threw the same way
 * for the month tiles).
 *
 * A third, quieter fault: the deletion-request count was organisation-wide,
 * while the queue on `/documents` only opens for `document.delete.approve`.
 * A team lead was told N items were waiting and then shown zero.
 */

const FILE = "src/services/dashboard.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function block(body: string, fn: string): string {
  const start = body.indexOf(`export async function ${fn}(`);
  expect(start, fn).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("getOrgDashboard cannot throw for a permission it lacks", () => {
  const body = block(code(FILE), "getOrgDashboard");

  it("resolves the employee scope itself and treats none as nobody to count", () => {
    expect(body).toMatch(/resolveScope\(ctx\.permissions, "employee\.read"\)/);
    // The throwing resolver is only reached once a scope is known to exist.
    expect(body).toMatch(/employeeScope === null\s*\?\s*\[\]/);
    expect(body).not.toMatch(/\bscopeFor\(/);
  });

  it("only counts a person's own month when their attendance is theirs to read", () => {
    expect(body).toMatch(/resolveScope\(ctx\.permissions, "attendance\.read"\) !== null/);
    const grid = body.indexOf("getMonthlyGrid(ctx");
    const guard = body.indexOf("canReadOwnAttendance\n");
    expect(grid).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(grid);
  });

  it("counts deletion requests only for somebody who can open that queue", () => {
    expect(body).toMatch(
      /hasPermission\(ctx, "document\.delete\.approve"\)\s*\?\s*prisma\.documentDeletionRequest\.count\(/,
    );
  });

  it("leaves the viewer's own request out of what is waiting for them", () => {
    // The team scope seeds itself with the viewer, so a team lead whose only
    // pending leave was their own read "1 pending item" and found the queue
    // on /leave -- which leaves their own out -- empty. A login with no
    // employee record has nothing of its own to leave out.
    expect(body).toMatch(/const notOwn = ctx\.employeeId \? \{ NOT: \{ employeeId: ctx\.employeeId \} \} : \{\}/);
    expect(body).toMatch(
      /prisma\.leaveRequest\.count\(\{\s*where: \{ organizationId: orgId, status: "PENDING", \.\.\.attendanceFilter, \.\.\.notOwn \}/,
    );
    expect(body).toMatch(
      /prisma\.attendanceRegularisation\.count\(\{\s*where: \{ organizationId: orgId, status: "PENDING", \.\.\.attendanceFilter, \.\.\.notOwn \}/,
    );
  });
});
