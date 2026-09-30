import { describe, expect, it } from "vitest";
import { formatPaise, paiseToWords } from "./money";

describe("paiseToWords", () => {
  const rupees = (n: number) => n * 100;

  it("spells a plain amount", () => {
    expect(paiseToWords(rupees(45_403))).toBe(
      "Rupees Forty Five Thousand Four Hundred Three only",
    );
  });

  it("uses lakh and crore, not million and billion", () => {
    // The people receiving these documents read in lakhs.
    expect(paiseToWords(rupees(250_000))).toBe("Rupees Two Lakh Fifty Thousand only");
    expect(paiseToWords(rupees(12_500_000))).toBe("Rupees One Crore Twenty Five Lakh only");
  });

  it("includes paise when there are any", () => {
    expect(paiseToWords(4_919_35)).toBe(
      "Rupees Four Thousand Nine Hundred Nineteen and Thirty Five Paise only",
    );
  });

  it("handles the teens, which are the usual off-by-one", () => {
    expect(paiseToWords(rupees(19))).toBe("Rupees Nineteen only");
    expect(paiseToWords(rupees(13_000))).toBe("Rupees Thirteen Thousand only");
  });

  it("says zero rather than nothing", () => {
    expect(paiseToWords(0)).toBe("Rupees Zero only");
  });

  it("marks a negative amount explicitly", () => {
    // A payslip should never show one, but a recovery statement might.
    expect(paiseToWords(rupees(-500))).toBe("Minus Rupees Five Hundred only");
  });

  it("does not lose the hundreds place inside a larger number", () => {
    expect(paiseToWords(rupees(1_00_101))).toBe(
      "Rupees One Lakh One Hundred One only",
    );
  });

  it("agrees with the formatted figure", () => {
    // The two appear side by side on a payslip; disagreeing would be alarming.
    const amount = rupees(55_000);
    expect(formatPaise(amount)).toBe("₹55,000.00");
    expect(paiseToWords(amount)).toBe("Rupees Fifty Five Thousand only");
  });
});

