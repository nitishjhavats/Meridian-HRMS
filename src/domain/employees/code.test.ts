import { describe, expect, it } from "vitest";
import {
  CODE_DIGITS,
  DEFAULT_CODE_PREFIX,
  InvalidCodePrefix,
  formatEmployeeCode,
  isValidCodePrefix,
  normaliseCodePrefix,
  serialFor,
  suggestCodePrefix,
} from "./code";

describe("normaliseCodePrefix", () => {
  it("upper-cases and trims", () => {
    expect(normaliseCodePrefix(" acm ")).toBe("ACM");
  });

  it("takes three letters or four", () => {
    // Four was added because three cannot hold a real company name in a shape
    // its own staff recognise: "Jivonik Ayurveda" is JVNK, "KamaWell" is KMWL,
    // and both lose their shape at three.
    expect(normaliseCodePrefix("jvnk")).toBe("JVNK");
    expect(normaliseCodePrefix("bmg")).toBe("BMG");
  });

  it("refuses anything shorter, longer, or not a letter", () => {
    // "ACM " is deliberately absent: surrounding whitespace is trimmed, not
    // rejected, because it is what a paste produces rather than what a person
    // meant. An internal space is a different thing.
    //
    // Five is where a mark starts being a word, and the serial has to stay the
    // part a reader can find.
    for (const bad of ["", "AC", "ACMES", "AC1", "A-C", " A C", "AC-", "ACME1"]) {
      expect(() => normaliseCodePrefix(bad), bad).toThrow(InvalidCodePrefix);
    }
  });

  it("refuses digits, because they make the serial ambiguous", () => {
    expect(() => normaliseCodePrefix("A24")).toThrow(InvalidCodePrefix);
  });

  it("has a matching non-throwing form", () => {
    expect(isValidCodePrefix("acm")).toBe(true);
    expect(isValidCodePrefix("acme")).toBe(true);
    expect(isValidCodePrefix("acmes")).toBe(false);
  });
});

describe("suggestCodePrefix", () => {
  it("squeezes the consonants out of the name", () => {
    /**
     * The two that were chosen by hand before this existed, and the reason the
     * rule is consonants rather than the first three letters: JIV and KAM are
     * the start of a word, JVNK and KMWL are a mark for it.
     */
    expect(suggestCodePrefix("Jivonik Ayurveda")).toBe("JVNK");
    expect(suggestCodePrefix("KamaWell Ayurveda")).toBe("KMWL");
    expect(suggestCodePrefix("Acme Technologies")).toBe("ACMT");
    expect(suggestCodePrefix("Bright Retail")).toBe("BRGH");
  });

  it("keeps a leading vowel, because dropping it loses the name", () => {
    // "Acme" would suggest CM without this, which is not a shortening of
    // anything a person would recognise.
    expect(suggestCodePrefix("Acme")).toBe("ACM");
    expect(suggestCodePrefix("Orion Labs")).toBe("ORNL");
  });

  it("skips anything that is not a letter", () => {
    expect(suggestCodePrefix("7-Eleven")).toBe("ELVN");
    expect(suggestCodePrefix("A. B. Corp")).toBe("ABCR");
  });

  it("pads a short name rather than producing something unusable", () => {
    expect(suggestCodePrefix("3M")).toBe("MXX");
    expect(suggestCodePrefix("Hi")).toBe("HIX");
  });

  it("falls back when a name carries no letters at all", () => {
    expect(suggestCodePrefix("123")).toBe(DEFAULT_CODE_PREFIX);
    expect(suggestCodePrefix("")).toBe(DEFAULT_CODE_PREFIX);
  });

  it("always produces something it would itself accept", () => {
    for (const name of ["Bright Retail", "3M", "123", "", "Ω Corp", "a"]) {
      expect(isValidCodePrefix(suggestCodePrefix(name))).toBe(true);
    }
  });
});

describe("formatEmployeeCode", () => {
  it("zero-pads to the shared width", () => {
    expect(formatEmployeeCode("ACM", 1)).toBe("ACM001");
    expect(formatEmployeeCode("acm", 42)).toBe("ACM042");
    expect(CODE_DIGITS).toBe(3);
  });

  it("lets the number outgrow the padding rather than truncating it", () => {
    expect(formatEmployeeCode("ACM", 1000)).toBe("ACM1000");
  });
});

describe("serialFor", () => {
  it("reads the serial back out", () => {
    expect(serialFor("ACM042", "ACM")).toBe(42);
    expect(serialFor("acm042", "acm")).toBe(42);
    expect(serialFor("ACM1000", "ACM")).toBe(1000);
  });

  it("ignores a code belonging to a different series", () => {
    expect(serialFor("BRI007", "ACM")).toBeNull();
    expect(serialFor("EMP001", "ACM")).toBeNull();
  });

  it("ignores a code with no serial, or one with anything after it", () => {
    expect(serialFor("ACM", "ACM")).toBeNull();
    expect(serialFor("ACM042A", "ACM")).toBeNull();
    expect(serialFor("ACM-042", "ACM")).toBeNull();
  });

  it("round-trips with formatEmployeeCode", () => {
    for (const n of [1, 7, 42, 999, 1000]) {
      expect(serialFor(formatEmployeeCode("ACM", n), "ACM")).toBe(n);
    }
  });
});
