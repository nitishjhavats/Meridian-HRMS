import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { confirmationDatePatch, isProvisional, suggestedConfirmationDate } from "./probation";

describe("suggestedConfirmationDate", () => {
  it("adds the probation default to the joining date", () => {
    expect(
      suggestedConfirmationDate({
        joiningDate: "2026-01-01",
        state: "PROBATION",
        trainingDays: 30,
        probationDays: 90,
      }),
    ).toBe("2026-04-01");
  });

  it("uses the training default when they start in training", () => {
    expect(
      suggestedConfirmationDate({
        joiningDate: "2026-01-01",
        state: "TRAINING",
        trainingDays: 30,
        probationDays: 90,
      }),
    ).toBe("2026-01-31");
  });

  it("crosses a month, a year and a leap day without help", () => {
    const across = suggestedConfirmationDate({
      joiningDate: "2027-12-20",
      state: "PROBATION",
      trainingDays: 30,
      probationDays: 90,
    });
    expect(across).toBe("2028-03-19"); // 2028 is a leap year: Feb has 29 days.
  });

  it("is blank for somebody starting permanent, rather than inventing a date", () => {
    for (const state of ["REGULAR", "CONFIRMED", "NOTICE_PERIOD"]) {
      expect(
        suggestedConfirmationDate({
          joiningDate: "2026-01-01",
          state,
          trainingDays: 30,
          probationDays: 90,
        }),
      ).toBe("");
    }
  });

  it("is blank when the joining date is missing or malformed", () => {
    for (const joiningDate of ["", "2026-1-1", "01/01/2026", "not a date"]) {
      expect(
        suggestedConfirmationDate({
          joiningDate,
          state: "PROBATION",
          trainingDays: 30,
          probationDays: 90,
        }),
      ).toBe("");
    }
  });
});

describe("confirmationDatePatch", () => {
  // The whole point of this function. A permanent employee's edit dialog never
  // renders the date input, so a payload carrying `confirmationDate: null`
  // would erase the date they were actually confirmed on -- which is what used
  // to happen every time somebody was renamed.
  it("omits the key entirely for a state that has no end date", () => {
    for (const state of ["REGULAR", "CONFIRMED", "NOTICE_PERIOD"]) {
      expect(confirmationDatePatch(state, "")).toEqual({});
      expect(confirmationDatePatch(state, "2026-04-01")).toEqual({});
      expect("confirmationDate" in confirmationDatePatch(state, "")).toBe(false);
    }
  });

  it("sends the date while somebody is still provisional", () => {
    expect(confirmationDatePatch("PROBATION", "2026-04-01")).toEqual({
      confirmationDate: "2026-04-01",
    });
    expect(confirmationDatePatch("TRAINING", "2026-01-31")).toEqual({
      confirmationDate: "2026-01-31",
    });
  });

  it("sends null when a rendered field was deliberately cleared", () => {
    expect(confirmationDatePatch("PROBATION", "")).toEqual({ confirmationDate: null });
  });
});

describe("isProvisional", () => {
  it("is exactly training and probation", () => {
    expect(isProvisional("TRAINING")).toBe(true);
    expect(isProvisional("PROBATION")).toBe(true);
    expect(isProvisional("REGULAR")).toBe(false);
    expect(isProvisional("CONFIRMED")).toBe(false);
    expect(isProvisional("")).toBe(false);
  });
});

/**
 * Pinning a pure function does not pin its caller.
 *
 * Round 2 learned this the expensive way: five green tests over
 * `eligibleForSuperadminRelease` stayed green after the call to it was deleted.
 * So this asserts the dialog actually routes through the module above, rather
 * than growing its own copy of the rule again.
 */
describe("the employee dialog uses these, rather than its own copy", () => {
  const source = readFileSync("src/app/(app)/employees/EmployeeForm.tsx", "utf8");

  it("imports them", () => {
    expect(source).toContain('from "@/domain/employees/probation"');
    expect(source).toContain("confirmationDatePatch");
    expect(source).toContain("suggestedConfirmationDate");
  });

  it("never spreads a bare confirmationDate into the payload again", () => {
    expect(source).not.toContain("confirmationDate: form.confirmationDate");
  });
});
