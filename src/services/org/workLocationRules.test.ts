import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Copying one branch's rules onto the others, and the line that must not move.
 *
 * "ek location ka setting doosre location me import karne ka feature de do",
 * asked for after four branches had been set up by hand. The whole risk in a
 * feature like this is copying one field too many: a branch's radius is policy
 * and can sensibly be the same everywhere, and a branch's *pin* is what makes
 * it that branch. Copy the pin and two offices claim one place, every employee
 * at the second one falls outside a fence centred on the first, and nothing on
 * any screen says why.
 */

const SERVICE = "src/services/org/structure.ts";
const ROUTE = "src/app/api/settings/structure/route.ts";
const SCREEN = "src/app/(app)/settings/organisation/Structure.tsx";

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function copyBody(): string {
  const body = code(SERVICE);
  const start = body.indexOf("export async function copyWorkLocationRules");
  expect(start).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

/** The object actually written to the other branches. */
function written(): string {
  const block = copyBody();
  const start = block.indexOf("const rules = {");
  expect(start, "no rules object").toBeGreaterThan(-1);
  return block.slice(start, block.indexOf("};", start));
}

describe("what travels between branches", () => {
  it("the three rules", () => {
    for (const field of ["radiusMeters", "requireGps", "requireSelfie"]) {
      expect(written(), field).toContain(field);
    }
  });

  it("and nothing else at all", () => {
    /**
     * The pin is the failure that costs money: a fence centred on the wrong
     * building refuses everybody standing in the right one, and the refusal
     * reads to them as an ordinary "you are not at the office".
     *
     * Asserted as a count rather than as a list of forbidden names, so a fourth
     * field added here has to be added here too, deliberately.
     */
    const fields = written().match(/^\s+(\w+):/gm) ?? [];
    expect(fields.map((f) => f.trim())).toEqual([
      "radiusMeters:",
      "requireGps:",
      "requireSelfie:",
    ]);
  });

  it("and the write sends exactly that object", () => {
    // `data: rules` and not a second literal that could drift from it.
    expect(copyBody()).toMatch(/data: rules,/);
  });
});

describe("and it stays inside the organisation", () => {
  it("reads the source branch with the tenant in the predicate", () => {
    expect(copyBody()).toMatch(/organizationId: ctx\.organizationId!/);
  });

  it("writes with the tenant in the predicate too", () => {
    // `updateMany` with the organisation in the `where` means an id from
    // another tenant matches nothing rather than being written to. A read check
    // followed by an unscoped write is the shape of the bug this avoids.
    const block = copyBody();
    const write = block.indexOf("updateMany");
    expect(write).toBeGreaterThan(-1);
    expect(block.slice(write, write + 300)).toMatch(/organizationId: ctx\.organizationId!/);
  });

  it("requires the permission that governs structure", () => {
    expect(copyBody()).toMatch(/requireWrite\(ctx, "org\.structure\.manage"\)/);
  });
});

describe("the screen and the route agree it exists", () => {
  it("the route accepts it", () => {
    // zod strips what it does not declare, so a kind missing here arrives as an
    // unknown discriminant and fails rather than silently doing nothing.
    expect(code(ROUTE)).toContain('z.literal("location-rules-copy")');
    expect(code(ROUTE)).toContain("copyWorkLocationRules(ctx, body)");
  });

  it("and the screen sends it", () => {
    expect(code(SCREEN)).toContain('kind: "location-rules-copy"');
  });

  it("the screen offers it only when there is somewhere to copy to", () => {
    // One branch and a "copy to the rest" button is a control that can only
    // disappoint.
    expect(code(SCREEN)).toMatch(/workLocations \?\? \[\]\)\.length > 1/);
  });
});
