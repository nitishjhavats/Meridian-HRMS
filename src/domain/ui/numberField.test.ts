import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPartialNumber, normaliseNumber } from "./numberField";

describe("what a person may be part-way through typing", () => {
  it("accepts an empty box", () => {
    // The whole bug in one assertion. An empty box is a state, not a zero.
    expect(isPartialNumber("", 0)).toBe(true);
    expect(isPartialNumber("", 2)).toBe(true);
  });

  it("accepts a lone decimal point on the way to a decimal", () => {
    expect(isPartialNumber("1.", 2)).toBe(true);
    expect(isPartialNumber("1.5", 2)).toBe(true);
    expect(isPartialNumber("1.50", 2)).toBe(true);
  });

  it("refuses a decimal point where whole numbers are wanted", () => {
    expect(isPartialNumber("1.", 0)).toBe(false);
    expect(isPartialNumber("1.5", 0)).toBe(false);
  });

  it("refuses more decimals than the field takes", () => {
    expect(isPartialNumber("1.234", 2)).toBe(false);
  });

  it("refuses anything that is not a number", () => {
    for (const raw of ["abc", "1e5", "-1", "1,000", " 1", "٣"]) {
      expect(isPartialNumber(raw, 2), raw).toBe(false);
    }
  });
});

describe("what the box settles on when it is left", () => {
  it("keeps empty as null rather than turning it into zero", () => {
    // A blank "free late marks" is not zero of them, and only the caller knows
    // which it means. `Number("")` being 0 is exactly what broke these fields.
    expect(normaliseNumber("")).toBeNull();
    expect(normaliseNumber("   ")).toBeNull();
  });

  it("rounds to whole numbers by default", () => {
    expect(normaliseNumber("12.6")).toBe(13);
    expect(normaliseNumber("12.4")).toBe(12);
  });

  it("keeps decimals when the field takes them", () => {
    expect(normaliseNumber("12.6", { decimals: 2 })).toBe(12.6);
  });

  it("clamps to the range", () => {
    expect(normaliseNumber("0", { min: 1 })).toBe(1);
    expect(normaliseNumber("500", { max: 100 })).toBe(100);
    expect(normaliseNumber("50", { min: 1, max: 100 })).toBe(50);
  });

  it("does not clamp a value that is still being typed", () => {
    // This is the second half of the reported bug. With `min: 1`, clamping on
    // each keystroke turns "10" into "1" -> clamp -> "1" and eats the zero as
    // it is typed. The guard is that clamping is only ever applied here, on
    // blur, and `isPartialNumber` is what runs while typing.
    expect(isPartialNumber("1", 0)).toBe(true);
    expect(isPartialNumber("10", 0)).toBe(true);
    expect(normaliseNumber("10", { min: 1 })).toBe(10);
  });

  it("falls back rather than producing NaN", () => {
    expect(normaliseNumber("abc", { fallback: 7 })).toBe(7);
    expect(normaliseNumber("abc")).toBeNull();
  });
});

/**
 * A pure rule pins nothing if the component stops asking it.
 */
describe("the component uses these and does not coerce on change", () => {
  const SOURCE = readFileSync(path.resolve("src/components/ui/number-field.tsx"), "utf8");
  const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("reports null for an empty box instead of a number", () => {
    expect(CODE).toMatch(/onValueChange\(raw === "" \? null : Number\(raw\)\)/);
  });

  it("holds a string while typing, not a number", () => {
    expect(CODE).toMatch(/useState<string \| null>\(null\)/);
  });

  it("clamps on blur and never on change", () => {
    const onChange = CODE.slice(CODE.indexOf("onChange={"), CODE.indexOf("onBlur={"));
    // Clamping while typing is the other half of the bug: with min 1, "10"
    // becomes "1" -> clamp -> "1" and the zero is eaten as it is typed.
    expect(onChange).not.toMatch(/Math\.max|Math\.min|Math\.round|normaliseNumber/);
    const onBlurBlock = CODE.slice(CODE.indexOf("onBlur={"));
    // Delegated rather than repeated: the range rules are tested directly
    // above, and a second copy here is a second thing to get wrong.
    expect(onBlurBlock).toMatch(/normaliseNumber\(raw, \{ min, max, decimals, fallback: value \}\)/);
  });

  it("does not use type=number, whose spinner and scroll wheel change values by accident", () => {
    expect(CODE).toMatch(/type="text"/);
    expect(CODE).not.toMatch(/type="number"/);
  });
});
