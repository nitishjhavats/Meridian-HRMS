import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  moveStep,
  offsetLabel,
  resolveChoice,
  splitByJoiningDate,
  toOffsetDays,
} from "./template";

describe("offsetLabel", () => {
  it("names the joining day rather than calling it zero", () => {
    expect(offsetLabel(0)).toBe("on the joining day");
  });

  it("reads a negative offset as before, not as minus", () => {
    expect(offsetLabel(-7)).toBe("7 days before joining");
    expect(offsetLabel(-1)).toBe("1 day before joining");
  });

  it("counts forward after joining", () => {
    expect(offsetLabel(1)).toBe("1 day after joining");
    expect(offsetLabel(30)).toBe("30 days after joining");
  });
});

describe("splitByJoiningDate", () => {
  it("separates the schedulable from the rest", () => {
    const { ready, undated } = splitByJoiningDate([
      { id: "a", joiningDate: "2026-04-01" },
      { id: "b", joiningDate: null },
      { id: "c", joiningDate: "2026-05-02" },
    ]);
    expect(ready.map((e) => e.id)).toEqual(["a", "c"]);
    expect(undated.map((e) => e.id)).toEqual(["b"]);
  });

  it("keeps the incoming order inside each side", () => {
    const { ready } = splitByJoiningDate([
      { id: "later", joiningDate: "2026-06-01" },
      { id: "earlier", joiningDate: "2026-01-01" },
    ]);
    expect(ready.map((e) => e.id)).toEqual(["later", "earlier"]);
  });

  it("puts everybody in undated when nobody has a date", () => {
    const { ready, undated } = splitByJoiningDate([{ id: "a", joiningDate: null }]);
    expect(ready).toEqual([]);
    expect(undated).toHaveLength(1);
  });
});

describe("moveStep", () => {
  it("swaps with the neighbour in the direction asked for", () => {
    expect(moveStep(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveStep(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("does nothing at either end", () => {
    expect(moveStep(["a", "b"], "a", -1)).toEqual(["a", "b"]);
    expect(moveStep(["a", "b"], "b", 1)).toEqual(["a", "b"]);
  });

  it("does nothing for an id that is not in the list", () => {
    expect(moveStep(["a", "b"], "zzz", 1)).toEqual(["a", "b"]);
  });

  it("does not mutate the list it was given", () => {
    const ids = ["a", "b", "c"];
    moveStep(ids, "a", 1);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("resolveChoice", () => {
  const options = [{ id: "one" }, { id: "two" }];

  it("returns what was chosen when it still exists", () => {
    expect(resolveChoice(options, "two")).toEqual({ id: "two" });
  });

  it("falls back to the first option for an empty or stale choice", () => {
    // The bug this exists for: the picker was seeded from an empty list, so it
    // held "" for ever, rendered as the first option, and left Set up disabled.
    expect(resolveChoice(options, "")).toEqual({ id: "one" });
    expect(resolveChoice(options, "deleted")).toEqual({ id: "one" });
  });

  it("returns null when there is nothing to choose", () => {
    expect(resolveChoice([], "one")).toBeNull();
  });
});

describe("toOffsetDays", () => {
  it("is zero on the joining day whatever the count says", () => {
    expect(toOffsetDays("on", 5)).toBe(0);
    expect(toOffsetDays("on", null)).toBe(0);
  });

  it("makes before negative and after positive", () => {
    expect(toOffsetDays("before", 7)).toBe(-7);
    expect(toOffsetDays("after", 7)).toBe(7);
  });

  it("treats a cleared box as zero rather than NaN", () => {
    expect(toOffsetDays("before", null)).toBe(0);
  });

  it("ignores a sign typed into the count", () => {
    // The control asks for "days before", so a negative there would mean after,
    // which nobody intends.
    expect(toOffsetDays("before", -3)).toBe(-3);
    expect(toOffsetDays("after", -3)).toBe(3);
  });
});

/**
 * Pinning a pure function pins nothing if its caller stops asking it.
 */
describe("the callers actually use these", () => {
  const strip = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  const read = (relative: string) => strip(readFileSync(path.resolve(relative), "utf8"));

  const SERVICE = read("src/services/onboarding/index.ts");
  const SCREEN = read("src/app/(app)/onboarding/Onboarding.tsx");
  const TEMPLATES = read("src/app/(app)/onboarding/Templates.tsx");

  it("reorders template steps through moveStep", () => {
    expect(SERVICE).toMatch(/moveStep\(/);
  });

  it("refuses to apply a template with no steps", () => {
    expect(SERVICE).toMatch(/template\.tasks\.length === 0/);
  });

  it("checks the employee belongs to this organisation before adding a task", () => {
    const add = SERVICE.slice(SERVICE.indexOf("export async function addTask("));
    expect(add).toMatch(/prisma\.employee\.findFirst/);
    expect(add).toMatch(/organizationId: ctx\.organizationId/);
  });

  it("scopes the joiner's own list to their own employee id", () => {
    const mine = SERVICE.slice(
      SERVICE.indexOf("export async function listMyTasks("),
      SERVICE.indexOf("export async function setTaskStatus("),
    );
    expect(mine).toMatch(/employeeId: ctx\.employeeId/);
    expect(mine).not.toMatch(/requirePermission/);
  });

  it("derives both pickers instead of storing a possibly stale id", () => {
    expect(SCREEN).toMatch(/resolveChoice\(ready,/);
    expect(SCREEN).toMatch(/resolveChoice\(templates,/);
  });

  it("only offers employees who have a joining date", () => {
    expect(SCREEN).toMatch(/splitByJoiningDate\(employees\)/);
  });

  it("shows the create-template control whatever the template count is", () => {
    // The whole complaint. The only create control used to sit inside
    // `templates.length === 0 ? ... : null`, so it vanished the moment the
    // first template existed and a second could never be made. Checked by
    // position: the control is rendered before the empty-state branch opens,
    // which is the one place it cannot be conditional on the count.
    const createAt = TEMPLATES.indexOf('action: "create"');
    const emptyBranchAt = TEMPLATES.indexOf("templates.length === 0");
    expect(createAt).toBeGreaterThan(-1);
    expect(emptyBranchAt).toBeGreaterThan(-1);
    expect(createAt).toBeLessThan(emptyBranchAt);
  });

  it("says each step's timing in words", () => {
    expect(TEMPLATES).toMatch(/offsetLabel\(step\.dueOffsetDays\)/);
    expect(TEMPLATES).toMatch(/toOffsetDays\(draft\.timing, draft\.days\)/);
  });
});
