import { describe, expect, it } from "vitest";
import {
  allocationDays,
  allocationOverrides,
  designationAllocation,
  effectiveAllocation,
  resolveAllocation,
} from "./allocation";

const OVERRIDES = allocationOverrides([
  { leaveTypeId: "casual", designationId: "manager", annualAllocation: 18 },
  { leaveTypeId: "casual", designationId: "trainee", annualAllocation: 0 },
  { leaveTypeId: "sick", designationId: "manager", annualAllocation: "7.50" },
]);

describe("effectiveAllocation", () => {
  it("uses the designation's number when there is one", () => {
    expect(
      effectiveAllocation(
        { leaveTypeId: "casual", typeDefault: 12, designationId: "manager" },
        OVERRIDES,
      ),
    ).toBe(18);
  });

  it("falls back to the leave type for a designation nobody set", () => {
    expect(
      effectiveAllocation(
        { leaveTypeId: "casual", typeDefault: 12, designationId: "engineer" },
        OVERRIDES,
      ),
    ).toBe(12);
  });

  it("falls back for somebody with no designation at all", () => {
    for (const designationId of [null, undefined, ""]) {
      expect(
        effectiveAllocation({ leaveTypeId: "casual", typeDefault: 12, designationId }, OVERRIDES),
      ).toBe(12);
    }
  });

  it("honours a designation that genuinely gets none", () => {
    // The reason this is `??` and not `||`. A trainee with no casual leave is a
    // policy somebody wrote down, and falling back to twelve would quietly
    // grant a fortnight nobody agreed to.
    expect(
      effectiveAllocation(
        { leaveTypeId: "casual", typeDefault: 12, designationId: "trainee" },
        OVERRIDES,
      ),
    ).toBe(0);
  });

  it("falls back for a leave type with no overrides at all", () => {
    expect(
      effectiveAllocation(
        { leaveTypeId: "earned", typeDefault: 15, designationId: "manager" },
        OVERRIDES,
      ),
    ).toBe(15);
  });

  it("does not mix one leave type's rows into another", () => {
    expect(
      effectiveAllocation(
        { leaveTypeId: "sick", typeDefault: 6, designationId: "trainee" },
        OVERRIDES,
      ),
    ).toBe(6);
  });
});

describe("allocationOverrides", () => {
  it("reads a Prisma Decimal as a number", () => {
    expect(
      effectiveAllocation(
        { leaveTypeId: "sick", typeDefault: 6, designationId: "manager" },
        OVERRIDES,
      ),
    ).toBe(7.5);
  });

  it("drops a row that is not a usable number", () => {
    // A malformed row must not become a silent zero: that would take leave away
    // from everybody holding the designation.
    const overrides = allocationOverrides([
      { leaveTypeId: "casual", designationId: "manager", annualAllocation: "nonsense" },
      { leaveTypeId: "casual", designationId: "hr", annualAllocation: -4 },
      { leaveTypeId: "casual", designationId: "ops", annualAllocation: null },
    ]);
    for (const designationId of ["manager", "hr", "ops"]) {
      expect(
        effectiveAllocation({ leaveTypeId: "casual", typeDefault: 12, designationId }, overrides),
      ).toBe(12);
    }
  });

  it("handles no rows", () => {
    const empty = allocationOverrides([]);
    expect(
      effectiveAllocation({ leaveTypeId: "casual", typeDefault: 12, designationId: "x" }, empty),
    ).toBe(12);
  });
});

/**
 * The precedence itself.
 *
 * `effectiveAllocation` above answers the two-layer question. This is the whole
 * ladder, and it is what every reader of an allocation now calls — the balance
 * grid, the employee's own leave screen, the year-end run, the full-and-final
 * settlement and the leave-balances report. They agreed on nothing before it:
 * only the screen that edits designation allocations ever read one.
 */
describe("resolveAllocation", () => {
  it("lets one person's own figure beat their designation and the company", () => {
    expect(resolveAllocation({ personal: 20, designation: 18, type: 12 })).toBe(20);
  });

  it("falls to the designation when the person has no figure of their own", () => {
    expect(resolveAllocation({ personal: null, designation: 18, type: 12 })).toBe(18);
    expect(resolveAllocation({ designation: 18, type: 12 })).toBe(18);
  });

  it("falls to the company when neither of the two below has anything to say", () => {
    expect(resolveAllocation({ personal: null, designation: null, type: 12 })).toBe(12);
    expect(resolveAllocation({ type: 12 })).toBe(12);
  });

  it("treats a stored zero at any layer as a real answer", () => {
    // A trainee whose designation grants no casual leave, and one employee
    // whose own row says zero. Both are policies somebody wrote down; falling
    // through would hand each of them a fortnight nobody agreed to.
    expect(resolveAllocation({ designation: 0, type: 12 })).toBe(0);
    expect(resolveAllocation({ personal: 0, designation: 18, type: 12 })).toBe(0);
  });

  it("does not let a missing designation become zero days", () => {
    // The trap this codebase has hit before. `Number(null)` is 0 and so is
    // `Number("")`, and both are finite — so a layer nobody has set would read
    // as "this person gets none", which then caps the accrual, fails the
    // balance check on a leave request, and settles the encashment line of a
    // full-and-final at nothing. Every one of these must fall through.
    for (const designation of [null, undefined, "", "   ", NaN, "nonsense", -3, true, []]) {
      expect(resolveAllocation({ designation, type: 12 }), String(designation)).toBe(12);
    }
  });

  it("reads a Prisma Decimal, which arrives as an object that stringifies", () => {
    const decimal = { toString: () => "7.50" };
    expect(resolveAllocation({ designation: decimal, type: 12 })).toBe(7.5);
    expect(resolveAllocation({ designation: "7.50", type: 12 })).toBe(7.5);
  });

  it("answers zero only when every layer is missing", () => {
    // Not a fallback anybody should reach: it means the leave type itself has
    // no usable allocation, and zero is the honest answer to that.
    expect(resolveAllocation({})).toBe(0);
    expect(resolveAllocation({ personal: null, designation: null, type: null })).toBe(0);
  });
});

describe("allocationDays", () => {
  it("separates 'no answer' from the number zero", () => {
    expect(allocationDays(null)).toBeNull();
    expect(allocationDays(undefined)).toBeNull();
    expect(allocationDays("")).toBeNull();
    expect(allocationDays(0)).toBe(0);
    expect(allocationDays("0")).toBe(0);
  });

  it("refuses a figure that could not be a day count", () => {
    expect(allocationDays(-1)).toBeNull();
    expect(allocationDays(NaN)).toBeNull();
    expect(allocationDays(Infinity)).toBeNull();
    expect(allocationDays("twelve")).toBeNull();
    // `Number(true)` is 1 and `Number([])` is 0. Neither is a day count.
    expect(allocationDays(true)).toBeNull();
    expect(allocationDays([])).toBeNull();
  });
});

describe("designationAllocation", () => {
  it("returns null for a role nobody has made an exception for", () => {
    expect(designationAllocation(OVERRIDES, "casual", "engineer")).toBeNull();
    expect(designationAllocation(OVERRIDES, "earned", "manager")).toBeNull();
  });

  it("returns null for somebody with no designation at all", () => {
    expect(designationAllocation(OVERRIDES, "casual", null)).toBeNull();
    expect(designationAllocation(OVERRIDES, "casual", undefined)).toBeNull();
    expect(designationAllocation(OVERRIDES, "casual", "")).toBeNull();
  });

  it("returns a genuine zero as zero and not as null", () => {
    // The distinction the whole ladder rests on: "this role gets none" has to
    // be tellable apart from "nobody has said anything about this role".
    expect(designationAllocation(OVERRIDES, "casual", "trainee")).toBe(0);
  });
});
