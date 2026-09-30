import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Three things on the performance screen that answered with less than they
 * knew.
 *
 * Opening a cycle toasted "Cycle opened." and dropped the service's answer,
 * which says how many reviews it wrote and whom it skipped for having no
 * primary manager -- so a new organisation with no reporting lines saw
 * success, zero reviews, and a cycle that could never be opened again. The
 * page refused everybody without an employee record, owners included, so the
 * owner who had just added their staff had no screen anywhere on which to
 * start a cycle. And the assign-goal dialog would send a chosen unit as no
 * measure at all when the target box was left empty.
 */

const PAGE = "src/app/(app)/performance/page.tsx";
const SCREEN = "src/app/(app)/performance/Performance.tsx";
const ASSIGN = "src/app/(app)/performance/AssignGoal.tsx";
const SERVICE = "src/services/performance/index.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("opening a review cycle", () => {
  const screen = code(SCREEN);

  it("reads the service's answer instead of assuming", () => {
    // The shape `openCycle` returns, pinned so a rename there fails here.
    const service = code(SERVICE);
    expect(service).toMatch(/opened: withManager\.length,\s*skipped: withoutManager\.map/);

    expect(screen).toMatch(/mutate<Opened>\(/);
    expect(screen).toMatch(/result\.opened === 0/);
    expect(screen).toMatch(/skipped because they have no primary manager/);
    expect(screen).not.toMatch(/success: "Cycle opened\."/);
  });

  it("asks first, with the numbers, because it cannot be undone", () => {
    expect(screen).toMatch(/onClick=\{\(\) => setOpening\(c\)\}/);
    expect(screen).toMatch(/A cycle cannot be opened twice\./);
    expect(screen).toMatch(/nobody \? "Open anyway" : "Open"/);
  });

  it("is counted for the page by the query openCycle itself runs", () => {
    const page = code(PAGE);
    // Not a copy of the rule in the page: `reviewableHeadcount` and
    // `openCycle` read one `reviewableEmployees`, which reviewable.test.ts
    // beside the service pins.
    expect(page).toMatch(/reviewableHeadcount\(ctx\)/);
    expect(page).not.toMatch(/managers: \{ some:/);
    expect(page).toMatch(/reviewable=\{reviewable\}/);
  });
});

describe("the page for a login with no employee record", () => {
  const page = code(PAGE);

  it("only turns away somebody who cannot run a cycle", () => {
    expect(page).toMatch(/ownEmployeeRecord: !canManage/);
    expect(page).not.toMatch(/if \(!ctx\.employeeId\) \{\s*return/);
  });

  it("still renders the screen, which takes a null employee id", () => {
    expect(page).toMatch(/employeeId=\{ctx\.employeeId\}/);
    expect(code(SCREEN)).toMatch(/employeeId: string \| null;/);
  });
});

describe("assigning a measured goal", () => {
  const assign = code(ASSIGN);

  it("sends the unit and the target together", () => {
    expect(assign).toMatch(/unit && target !== null \? \{ unit, targetNumber: target \}/);
  });

  it("waits for the target once a unit is chosen", () => {
    expect(assign).toMatch(/\(unit !== "" && target === null\)/);
  });

  it("clears the measure with the rest after a save", () => {
    expect(assign).toMatch(/setUnit\(""\);\s*setTarget\(null\);/);
  });
});
