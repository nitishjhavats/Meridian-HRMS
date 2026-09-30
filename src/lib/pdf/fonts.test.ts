import { describe, expect, it } from "vitest";
import { formatPaise } from "@/domain/money";
import { formatPdfMoney, toPdfSafeText } from "./fonts";

/**
 * Both halves of the PDF money decision.
 *
 * These used to live on a second exported formatter, `formatPaiseAscii`, which
 * meant the tests proved the substitution worked but never that `formatPdfMoney`
 * actually reached for it — the branch that decides was the untested part. It is
 * a parameter now, so both answers are checked here rather than depending on
 * whether the machine running the suite happens to have the font files.
 */

describe("formatPdfMoney", () => {
  it("uses the rupee sign when the font can draw it", () => {
    expect(formatPdfMoney(5_767_400, "INR", true)).toBe("₹57,674.00");
  });

  it("writes Rs when it cannot, rather than a wrong glyph", () => {
    // Helvetica's WinAnsi encoding has no U+20B9 and degrades it to a
    // superscript one, so the alternative to this line is a payslip printing
    // "¹57,674.00" — wrong money, silently.
    expect(formatPdfMoney(5_767_400, "INR", false)).toBe("Rs 57,674.00");
  });

  it("keeps the same digits either way", () => {
    const paise = 491_935;
    expect(formatPdfMoney(paise, "INR", false).replace("Rs ", "")).toBe(
      formatPdfMoney(paise, "INR", true).replace("₹", ""),
    );
    expect(formatPdfMoney(paise, "INR", true)).toBe(formatPaise(paise));
  });

  it("produces latin1-safe output on the fallback path", () => {
    const output = formatPdfMoney(12_345_678, "INR", false);
    expect([...output].every((c) => c.charCodeAt(0) < 256)).toBe(true);
  });

  it("leaves a non-rupee currency alone on both paths", () => {
    // The substitution is specific to the one glyph Helvetica lacks; a dollar
    // sign draws fine and must not be rewritten.
    expect(formatPdfMoney(100_00, "USD", false)).toBe(formatPdfMoney(100_00, "USD", true));
  });
});

describe("toPdfSafeText", () => {
  const RUPEE = String.fromCharCode(0x20b9);

  it("leaves text alone when the font can draw the sign", () => {
    expect(toPdfSafeText(`${RUPEE}18,000.00 carries forward`, true)).toBe(
      `${RUPEE}18,000.00 carries forward`,
    );
  });

  it("substitutes when it cannot", () => {
    expect(toPdfSafeText(`${RUPEE}18,000.00 carries forward`, false)).toBe(
      "Rs 18,000.00 carries forward",
    );
  });

  it("swallows a space that already followed the sign, rather than doubling it", () => {
    expect(toPdfSafeText(`${RUPEE} 500 owing`, false)).toBe("Rs 500 owing");
  });

  it("handles every occurrence, not only the first", () => {
    expect(toPdfSafeText(`${RUPEE}100 of ${RUPEE}500`, false)).toBe("Rs 100 of Rs 500");
  });

  it("passes null and undefined through untouched", () => {
    // Callers hand it optional fields -- a footer note that is not there is not
    // an empty string, and turning it into one would print a blank line.
    expect(toPdfSafeText(null, false)).toBeNull();
    expect(toPdfSafeText(undefined, false)).toBeUndefined();
    expect(toPdfSafeText("", false)).toBe("");
  });

  it("touches nothing else", () => {
    const text = "Deducted 2.5% under section 192; see note (a).";
    expect(toPdfSafeText(text, false)).toBe(text);
  });

  it("agrees with formatPdfMoney on the same amount", () => {
    // The two must not spell the same figure differently on one page -- which
    // is exactly what happened when the payslip table used one and the note
    // beneath it used neither.
    const paise = 1_800_000;
    expect(toPdfSafeText(formatPdfMoney(paise, "INR", true), false)).toBe(
      formatPdfMoney(paise, "INR", false),
    );
  });
});
