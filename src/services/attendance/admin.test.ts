import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the month grid includes.
 *
 * Two silent omissions lived in the one employee query behind it. The
 * profile's calendar asked for a named person and got the whole-organisation
 * `active: true` filter along with it, so anybody who had left showed
 * "Nothing recorded" for every month they ever worked -- including the final
 * month HR checks before a settlement. And the organisation-wide grid stopped
 * at two hundred people by employee code, with the tiles summed from those
 * rows and nothing on screen to say anybody was missing.
 */

const ADMIN = "src/services/attendance/admin.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("getMonthlyGrid", () => {
  const grid = bodyOf(ADMIN, "export async function getMonthlyGrid(");

  it("filters on active only for the whole-organisation grid, never for a named person", () => {
    expect(grid).toMatch(/\.\.\.\(options\.employeeId \? \{\} : \{ active: true \}\)/);
    expect(grid).not.toMatch(/organizationId: ctx\.organizationId,\s*active: true,/);
  });

  it("still refuses a named person outside the reader's scope before querying", () => {
    // Dropping `active` widens nothing: the visible-ids check is what keeps a
    // team lead out of a stranger's month, and it runs first.
    expect(grid).toMatch(/if \(visible !== null && !visible\.includes\(options\.employeeId\)\)/);
  });

  it("does not cut the grid at a number nobody is shown", () => {
    expect(grid).not.toMatch(/take:\s*\d+/);
  });
});
