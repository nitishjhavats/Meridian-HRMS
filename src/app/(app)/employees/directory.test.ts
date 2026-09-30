import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";

/**
 * The directory's one row for a self-scoped reader is not a link to a page
 * that refuses them.
 *
 * `/employees` admits `employee.read.self` -- a Team Member or Supervisor who
 * types the URL sees "My team" with exactly themselves in it -- while the
 * profile page admits only `.all` and `.team`. The row used to link anyway.
 */

const DIRECTORY = "src/app/(app)/employees/page.tsx";
const PROFILE = "src/app/(app)/employees/[id]/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("who reaches which page", () => {
  it("a Team Member and a Supervisor hold read.self and neither of the others", () => {
    for (const role of ["TEAM_MEMBER", "SUPERVISOR"] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain("employee.read.self");
      expect(ROLE_PERMISSIONS[role]).not.toContain("employee.read.team");
      expect(ROLE_PERMISSIONS[role]).not.toContain("employee.read.all");
    }
  });

  it("the directory admits read.self; the profile does not", () => {
    expect(code(DIRECTORY)).toMatch(
      /anyPermission: \["employee\.read\.all", "employee\.read\.team", "employee\.read\.self"\]/,
    );
    expect(code(PROFILE)).toMatch(/anyPermission: \["employee\.read\.all", "employee\.read\.team"\]/);
  });
});

describe("the row", () => {
  const page = code(DIRECTORY);

  it("is a link only when the profile would open", () => {
    expect(page).toMatch(
      /canOpenProfile =\s*hasPermission\(ctx, "employee\.read\.all"\) \|\| hasPermission\(ctx, "employee\.read\.team"\)/,
    );
    // Both the table row and the card go through the same switch.
    expect(page.match(/<ProfileLink/g)).toHaveLength(2);
    expect(page.match(/linked=\{canOpenProfile\}/g)).toHaveLength(2);
    expect(page).toMatch(/if \(!linked\) return <span className=\{className\}>\{children\}<\/span>;/);
  });

  it("no row links straight to the profile any more", () => {
    expect(page).not.toMatch(/<Link href=\{`\/employees\/\$\{e\.id\}`\}/);
  });
});
