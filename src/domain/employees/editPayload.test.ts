import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { autoSuggestedManager, employmentStatePatch, reportsToPatch } from "./editPayload";

describe("employmentStatePatch", () => {
  it("sends the starting state for somebody new", () => {
    expect(employmentStatePatch(false, "PROBATION")).toEqual({ employmentState: "PROBATION" });
  });

  it("sends nothing on an edit, whatever the record says", () => {
    // The PATCH schema admits only the states a person can start in, and the
    // dialog never renders the field on an edit. Sending a resigned employee's
    // state failed validation with nothing highlighted, on every save.
    for (const state of ["RESIGNED", "TERMINATED", "INACTIVE", "CONFIRMED", "PROBATION"]) {
      expect(employmentStatePatch(true, state)).toEqual({});
    }
  });
});

describe("reportsToPatch", () => {
  it("a creation always sends what it has, null for nobody", () => {
    expect(reportsToPatch({ editing: false, initial: "", current: "mgr-a" })).toEqual({
      reportsToEmployeeId: "mgr-a",
    });
    expect(reportsToPatch({ editing: false, initial: "", current: "" })).toEqual({
      reportsToEmployeeId: null,
    });
  });

  it("an edit that left the manager alone sends nothing", () => {
    // `updateEmployee` opens a new line for any manager that differs from the
    // live one. Sending the same id back is a no-op today; sending an empty
    // field from a dialog that opened empty was how a phone-number fix ended
    // somebody's reporting line.
    expect(reportsToPatch({ editing: true, initial: "mgr-a", current: "mgr-a" })).toEqual({});
    expect(reportsToPatch({ editing: true, initial: "", current: "" })).toEqual({});
  });

  it("an edit that picked somebody else sends the choice", () => {
    expect(reportsToPatch({ editing: true, initial: "mgr-a", current: "mgr-b" })).toEqual({
      reportsToEmployeeId: "mgr-b",
    });
    expect(reportsToPatch({ editing: true, initial: "", current: "mgr-b" })).toEqual({
      reportsToEmployeeId: "mgr-b",
    });
  });

  it("an edit that picked and then put it back sends nothing", () => {
    expect(reportsToPatch({ editing: true, initial: "mgr-a", current: "mgr-a" })).toEqual({});
  });
});

describe("autoSuggestedManager", () => {
  const one = [{ id: "mgr-a" }];
  const two = [{ id: "mgr-a" }, { id: "mgr-b" }];

  it("fills an empty field on a new person when the chart is unambiguous", () => {
    expect(
      autoSuggestedManager({ editing: false, designationChanged: false, chosen: "", candidates: one }),
    ).toBe("mgr-a");
  });

  it("never overrides a choice, and never guesses between several", () => {
    expect(
      autoSuggestedManager({ editing: false, designationChanged: true, chosen: "mgr-z", candidates: one }),
    ).toBeNull();
    expect(
      autoSuggestedManager({ editing: false, designationChanged: true, chosen: "", candidates: two }),
    ).toBeNull();
    expect(
      autoSuggestedManager({ editing: false, designationChanged: true, chosen: "", candidates: [] }),
    ).toBeNull();
  });

  it("stays silent when an edit dialog merely opens", () => {
    // Opening the dialog is not choosing a designation. This is the case that
    // reassigned Y from A to B on a save that only touched the phone.
    expect(
      autoSuggestedManager({ editing: true, designationChanged: false, chosen: "", candidates: one }),
    ).toBeNull();
  });

  it("speaks again once the designation is changed on an edit", () => {
    expect(
      autoSuggestedManager({ editing: true, designationChanged: true, chosen: "", candidates: one }),
    ).toBe("mgr-a");
  });
});

/**
 * The dialog has to route through these rather than keep its own copy -- the
 * same lesson `probation.test.ts` records: tests over a rule stay green after
 * the call to it is deleted.
 */
describe("the employee dialog uses these, rather than its own copy", () => {
  const source = readFileSync("src/app/(app)/employees/EmployeeForm.tsx", "utf8").replace(
    /\r\n/g,
    "\n",
  );

  it("imports all three", () => {
    expect(source).toContain('from "@/domain/employees/editPayload"');
    expect(source).toContain("employmentStatePatch(editing, form.employmentState)");
    expect(source).toContain("reportsToPatch({");
    expect(source).toContain("autoSuggestedManager({");
  });

  it("never puts a bare employmentState or reportsToEmployeeId on the wire again", () => {
    expect(source).not.toContain("employmentState: form.employmentState,");
    expect(source).not.toContain("reportsToEmployeeId: form.reportsToEmployeeId || null");
  });

  it("marks the designation as chosen where it changes, and nowhere else sets the flag", () => {
    const sets = source.match(/designationTouched\.current = true/g) ?? [];
    expect(sets).toHaveLength(1);
    const at = source.indexOf("designationTouched.current = true");
    // Inside the designation select's change handler, not the effect.
    expect(source.lastIndexOf('id="designationId"', at)).toBeGreaterThan(-1);
    expect(at - source.lastIndexOf('id="designationId"', at)).toBeLessThan(200);
  });
});

/**
 * And the profile has to hand the dialog the live primary manager, or the
 * "unchanged" comparison above is against an empty field and every save that
 * picks the manager they already have opens a duplicate line request.
 */
describe("the profile opens the edit dialog on the live primary manager", () => {
  const page = readFileSync("src/app/(app)/employees/[id]/page.tsx", "utf8").replace(/\r\n/g, "\n");

  it("reads the line through the same call updateEmployee reads it with, and passes it in", () => {
    // Not its own where-clause: the page carried a copy of the predicate, and
    // two copies agree only until one is edited. The one query is
    // `livePrimaryLine` in services/org/structure, which livePrimaryLine.test.ts
    // pins the write side to.
    expect(page).toContain('import { livePrimaryLine } from "@/services/org/structure"');
    expect(page).toMatch(/const primaryLine = canEdit \? await livePrimaryLine\(ctx, id\) : null/);
    expect(page).toMatch(/reportsToEmployeeId: primaryLine\?\.managerId \?\? ""/);
    expect(page).not.toContain("@/lib/db/prisma");
    expect(page).not.toMatch(/endDate: null/);
  });
});
