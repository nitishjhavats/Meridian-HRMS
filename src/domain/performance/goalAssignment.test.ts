import { describe, expect, it } from "vitest";
import { planGoalAssignment } from "./goalAssignment";

describe("planGoalAssignment", () => {
  it("keeps the order the admin ticked people in", () => {
    const plan = planGoalAssignment(["c", "a", "b"], ["a", "b", "c"]);
    expect(plan.employeeIds).toEqual(["c", "a", "b"]);
    expect(plan.unresolved).toEqual([]);
  });

  it("writes one goal for somebody named twice", () => {
    const plan = planGoalAssignment(["a", "a", "b", "a"], ["a", "b"]);
    expect(plan.employeeIds).toEqual(["a", "b"]);
  });

  it("names the ids that resolved to nobody instead of dropping them", () => {
    // This is the whole point: a request naming five people and writing three
    // goals must not report success. The caller refuses on `unresolved`.
    const plan = planGoalAssignment(["a", "ghost", "b"], ["a", "b"]);
    expect(plan.employeeIds).toEqual(["a", "b"]);
    expect(plan.unresolved).toEqual(["ghost"]);
  });

  it("treats an employee from another organisation as unresolved", () => {
    // The service builds `assignable` from a query scoped to the caller's own
    // organisation, so a foreign id simply is not in the set — it is not found
    // rather than refused, which is what a stranger should learn about it.
    const plan = planGoalAssignment(["mine", "theirs"], ["mine"]);
    expect(plan.employeeIds).toEqual(["mine"]);
    expect(plan.unresolved).toEqual(["theirs"]);
  });

  it("reports a repeated bad id once", () => {
    const plan = planGoalAssignment(["ghost", "ghost"], []);
    expect(plan.unresolved).toEqual(["ghost"]);
  });

  it("has nothing to do when nobody was ticked", () => {
    const plan = planGoalAssignment([], ["a"]);
    expect(plan).toEqual({ employeeIds: [], unresolved: [] });
  });
});
