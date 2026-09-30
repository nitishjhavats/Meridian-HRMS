import { describe, expect, it } from "vitest";
import { aadhaarDigits, aadhaarLastFour, isAadhaarLastFour } from "./aadhaar";

describe("aadhaarLastFour", () => {
  it("keeps only the last four digits", () => {
    expect(aadhaarLastFour("234512345678")).toBe("5678");
  });

  it("ignores the spaces and dashes people type", () => {
    // The same number written three ways has to reduce to the same four
    // digits, or the migration and the form disagree about what is stored.
    expect(aadhaarLastFour("2345 1234 5678")).toBe("5678");
    expect(aadhaarLastFour("2345-1234-5678")).toBe("5678");
    expect(aadhaarDigits("2345 1234 5678")).toBe("234512345678");
  });

  it("returns null rather than something that looks like data", () => {
    expect(aadhaarLastFour(null)).toBeNull();
    expect(aadhaarLastFour("")).toBeNull();
    expect(aadhaarLastFour("   ")).toBeNull();
    // Fewer than four digits is a typo, not a partial number.
    expect(aadhaarLastFour("12")).toBeNull();
    expect(aadhaarLastFour("abcd")).toBeNull();
  });

  it("is idempotent — reducing an already-reduced value changes nothing", () => {
    // The migration is safe to run twice, which is the only way anybody will
    // ever be confident enough to run it once.
    expect(aadhaarLastFour("5678")).toBe("5678");
    expect(aadhaarLastFour(aadhaarLastFour("234512345678"))).toBe("5678");
  });
});

describe("isAadhaarLastFour", () => {
  it("recognises a reduced value", () => {
    expect(isAadhaarLastFour("5678")).toBe(true);
    expect(isAadhaarLastFour("0001")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isAadhaarLastFour("234512345678")).toBe(false);
    expect(isAadhaarLastFour("567")).toBe(false);
    expect(isAadhaarLastFour("56789")).toBe(false);
    expect(isAadhaarLastFour(null)).toBe(false);
    expect(isAadhaarLastFour("56a8")).toBe(false);
  });
});
