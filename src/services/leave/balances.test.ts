import { describe, expect, it } from "vitest";
import type { LeaveBalanceState } from "@/domain/leave";
import {
  type CarryForwardPerson,
  type CarryForwardPlanInput,
  type CarryForwardType,
  planCarryForward,
} from "./balances";

/**
 * The year-end run, as arithmetic.
 *
 * The failure this guards against is the expensive one: a run that adds
 * carry-forward to whatever is already recorded doubles every balance in the
 * organisation the second time somebody presses the button, and nobody notices
 * until people start taking leave they have not got. So the central test here
 * feeds the plan's own output back in as next year's opening position and
 * insists that nothing moves.
 */

const EL: CarryForwardType = {
  id: "el",
  code: "EL",
  name: "Earned leave",
  accrues: false,
  carryForward: true,
  maxCarryForward: 15,
  annualAllocation: 18,
};

const SL: CarryForwardType = {
  id: "sl",
  code: "SL",
  name: "Sick leave",
  accrues: false,
  carryForward: false,
  maxCarryForward: 0,
  annualAllocation: 8,
};

/** Monthly accrual: what is granted is what has accrued, not the allocation. */
const CL: CarryForwardType = {
  id: "cl",
  code: "CL",
  name: "Casual leave",
  accrues: true,
  carryForward: true,
  maxCarryForward: 6,
  annualAllocation: 12,
};

const asha: CarryForwardPerson = { id: "e1", code: "BM-001", name: "Asha Nair" };
const rahul: CarryForwardPerson = { id: "e2", code: "BM-002", name: "Rahul Menon" };

const state = (over: Partial<LeaveBalanceState> = {}): LeaveBalanceState => ({
  allocated: 18,
  accrued: 0,
  used: 0,
  carriedForward: 0,
  encashed: 0,
  ...over,
});

function plan(over: Partial<CarryForwardPlanInput> = {}) {
  return planCarryForward({
    types: [EL, SL],
    people: [asha, rahul],
    closing: new Map([
      ["e1:el", state({ used: 6 })], // 12 left, capped to 15 → 12 carries
      ["e2:el", state({ used: 0 })], // 18 left, capped to 15 → 3 lapse
    ]),
    opening: new Map(),
    ...over,
  });
}

describe("planCarryForward", () => {
  it("carries what is left, capped by the type's own limit", () => {
    const result = plan();

    expect(result.lines.map((l) => [l.employeeCode, l.carried, l.lapsed])).toEqual([
      ["BM-001", 12, 0],
      ["BM-002", 15, 3],
    ]);
    expect(result.employees).toBe(2);
    expect(result.days).toBe(27);
    expect(result.lapsed).toBe(3);
    expect(result.created).toBe(2);
  });

  it("does not double a balance when the run happens twice", () => {
    const first = plan();
    // Exactly what the commit writes: next year's `carriedForward`, set.
    const opening = new Map(first.lines.map((l) => [`${l.employeeId}:${l.leaveTypeId}`, l.carried]));

    const second = plan({ opening });

    expect(second.lines.every((l) => l.action === "UNCHANGED")).toBe(true);
    expect(second.employees).toBe(0);
    expect(second.days).toBe(0);
    expect(second.created + second.updated).toBe(0);
    expect(second.unchanged).toBe(2);
    // The figure itself has not grown, which is the thing that matters.
    expect(second.lines.map((l) => l.carried)).toEqual([12, 15]);
  });

  it("corrects a balance that no longer matches the year it came from", () => {
    // Somebody's leave was cancelled after the first run, so last year closed
    // with more left over than it did the first time round.
    const opening = new Map([["e1:el", 12]]);
    const result = plan({
      opening,
      closing: new Map([["e1:el", state({ used: 2 })]]),
      people: [asha],
    });

    expect(result.lines[0]?.action).toBe("UPDATE");
    // 16 left, capped at 15 — set, not added to the 12 already there.
    expect(result.lines[0]?.carried).toBe(15);
    expect(result.days).toBe(15);
  });

  it("leaves types that do not carry forward alone", () => {
    const result = plan({
      types: [SL],
      closing: new Map([["e1:sl", state({ allocated: 8, used: 1 })]]),
    });

    expect(result.lines).toEqual([]);
    expect(result.days).toBe(0);
  });

  it("carries what an accrual type actually accrued, not its annual allocation", () => {
    const result = plan({
      types: [CL],
      people: [asha],
      // Nine months in at one a month, three taken.
      closing: new Map([["e1:cl", state({ allocated: 12, accrued: 9, used: 3 })]]),
    });

    expect(result.lines[0]?.unused).toBe(6);
    expect(result.lines[0]?.carried).toBe(6);
  });

  it("writes nothing for somebody with nothing left", () => {
    const result = plan({
      people: [asha],
      closing: new Map([["e1:el", state({ used: 18 })]]),
    });

    expect(result.lines).toEqual([]);
    expect(result.created).toBe(0);
  });

  it("clears a stale carry-forward when the year it came from no longer supports it", () => {
    // The first run carried 12; the leave register has since been corrected and
    // there is nothing left to carry. The row has to come down, not stay.
    const result = plan({
      people: [asha],
      closing: new Map([["e1:el", state({ used: 18 })]]),
      opening: new Map([["e1:el", 12]]),
    });

    expect(result.lines[0]?.action).toBe("UPDATE");
    expect(result.lines[0]?.carried).toBe(0);
    expect(result.updated).toBe(1);
  });

  it("counts a person once however many types move", () => {
    const result = plan({
      types: [EL, CL],
      people: [asha],
      closing: new Map([
        ["e1:el", state({ used: 6 })],
        ["e1:cl", state({ allocated: 12, accrued: 9, used: 3 })],
      ]),
    });

    expect(result.lines).toHaveLength(2);
    expect(result.employees).toBe(1);
    expect(result.days).toBe(18);
  });
});
