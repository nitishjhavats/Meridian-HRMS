import { describe, expect, it } from "vitest";
import { soleSuggestedManager, suggestManagers } from "./suggestManager";

const ENGINEER = "d-engineer";
const LEAD = "d-lead";
const HEAD = "d-head";

const PARENTS = { [ENGINEER]: [LEAD], [LEAD]: [HEAD] };

const MANAGERS = [
  { id: "e1", name: "Asha Rao", designationId: LEAD },
  { id: "e2", name: "Vikram Singh", designationId: LEAD },
  { id: "e3", name: "Meera Nair", designationId: HEAD },
  { id: "e4", name: "Imported Person", designationId: null },
];

describe("suggestManagers", () => {
  it("returns the holders of the parent designation, and nobody else", () => {
    const found = suggestManagers({
      designationId: ENGINEER,
      designationParents: PARENTS,
      managers: MANAGERS,
    });
    // The head is two levels up. Suggesting them would skip the lead who
    // actually approves this person's leave.
    expect(found.map((m) => m.id)).toEqual(["e1", "e2"]);
  });

  it("never suggests somebody as their own manager", () => {
    const found = suggestManagers({
      designationId: LEAD,
      designationParents: PARENTS,
      managers: MANAGERS,
      excludeEmployeeId: "e3",
    });
    expect(found).toEqual([]);
  });

  it("ignores people with no designation", () => {
    // The bulk importer creates plenty of these. Without the guard, a null
    // designationId would match a parent list containing null.
    const found = suggestManagers({
      designationId: ENGINEER,
      designationParents: { [ENGINEER]: [null as unknown as string] },
      managers: MANAGERS,
    });
    expect(found).toEqual([]);
  });

  it("is empty when there is nothing to go on", () => {
    const base = { designationParents: PARENTS, managers: MANAGERS };
    expect(suggestManagers({ ...base, designationId: null })).toEqual([]);
    expect(suggestManagers({ ...base, designationId: undefined })).toEqual([]);
    // A designation at the top of the chart reports to nothing.
    expect(suggestManagers({ ...base, designationId: HEAD })).toEqual([]);
    // Nobody holds the parent designation.
    expect(
      suggestManagers({ ...base, designationId: ENGINEER, managers: [MANAGERS[3]!] }),
    ).toEqual([]);
  });

  it("follows every parent when a designation reports to more than one", () => {
    const found = suggestManagers({
      designationId: ENGINEER,
      designationParents: { [ENGINEER]: [LEAD, HEAD] },
      managers: MANAGERS,
    });
    expect(found.map((m) => m.id)).toEqual(["e1", "e2", "e3"]);
  });
});

describe("soleSuggestedManager", () => {
  it("answers only when there is exactly one candidate", () => {
    expect(
      soleSuggestedManager({
        designationId: LEAD,
        designationParents: PARENTS,
        managers: MANAGERS,
      })?.id,
    ).toBe("e3");
  });

  it("returns null for several, not the first", () => {
    // The whole point. Two Engineering Managers is a question for a human, and
    // silently taking the first is how somebody's approvals reach a stranger.
    expect(
      soleSuggestedManager({
        designationId: ENGINEER,
        designationParents: PARENTS,
        managers: MANAGERS,
      }),
    ).toBeNull();
  });

  it("returns null for none", () => {
    expect(
      soleSuggestedManager({
        designationId: HEAD,
        designationParents: PARENTS,
        managers: MANAGERS,
      }),
    ).toBeNull();
  });
});
