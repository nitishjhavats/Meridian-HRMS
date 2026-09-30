/**
 * Money = integer minor units (paise). Never a float.
 *
 * Every rounding decision in the product funnels through this module so that a
 * payroll result is byte-identical for identical inputs.
 */

export type Money = number;

export const PAISE_PER_RUPEE = 100;

export class MoneyError extends Error {}

function assertInt(v: number, what: string): void {
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw new MoneyError(`${what} must be an integer number of paise, got ${v}`);
  }
}

/** Half-up rounding on the absolute value, so -0.5 → -1 and 0.5 → 1 (symmetric). */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) throw new MoneyError(`cannot round ${value}`);
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value) + Number.EPSILON);
}

export function rupeesToPaise(rupees: number): Money {
  return roundHalfUp(rupees * PAISE_PER_RUPEE);
}

export function paiseToRupees(paise: Money): number {
  assertInt(paise, "amount");
  return paise / PAISE_PER_RUPEE;
}

/** amount × factor, rounded. Used for prorating. */
export function mul(amount: Money, factor: number): Money {
  assertInt(amount, "amount");
  if (!Number.isFinite(factor)) throw new MoneyError(`bad factor ${factor}`);
  return roundHalfUp(amount * factor);
}

/** percent of amount. `percent` is 0..100 (may be fractional). */
export function pct(amount: Money, percent: number): Money {
  assertInt(amount, "amount");
  if (!Number.isFinite(percent)) throw new MoneyError(`bad percent ${percent}`);
  return roundHalfUp((amount * percent) / 100);
}

/** amount ÷ divisor, rounded. Divisor of 0 yields 0 rather than Infinity. */
export function div(amount: Money, divisor: number): Money {
  assertInt(amount, "amount");
  if (divisor === 0) return 0;
  return roundHalfUp(amount / divisor);
}

/** ratio of two day counts, guarded against division by zero. */
export function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export function sum(values: readonly Money[]): Money {
  let total = 0;
  for (const v of values) {
    assertInt(v, "amount");
    total += v;
  }
  return total;
}

export function clampNonNegative(amount: Money): Money {
  return amount < 0 ? 0 : amount;
}

export type RoundingMode = "NONE" | "NEAREST" | "UP" | "DOWN";

export interface RoundingConfig {
  /** NONE keeps exact paise. */
  mode: RoundingMode;
  /** Granularity in paise. 100 = round to whole rupees, 10000 = to ₹100. */
  to: number;
}

export function applyRounding(amount: Money, config: RoundingConfig): Money {
  assertInt(amount, "amount");
  if (config.mode === "NONE" || config.to <= 1) return amount;
  const q = amount / config.to;
  switch (config.mode) {
    case "NEAREST":
      return roundHalfUp(q) * config.to;
    case "UP":
      return Math.ceil(q) * config.to;
    case "DOWN":
      return Math.floor(q) * config.to;
    default:
      return amount;
  }
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

/** Display helper. Presentation only — never feed the result back into maths. */
export function formatPaise(paise: Money, currency = "INR"): string {
  if (currency === "INR") return inrFormatter.format(paiseToRupees(paise));
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(
    paiseToRupees(paise),
  );
}

// ------------------------------------------------------------------ words

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function underThousand(n: number): string {
  if (n === 0) return "";
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const rest = n % 10;
    return TENS[Math.floor(n / 10)]! + (rest ? ` ${ONES[rest]}` : "");
  }
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} Hundred${rest ? ` ${underThousand(rest)}` : ""}`;
}

/**
 * An amount written out, in the Indian system.
 *
 * Payslips and cheques carry the figure in words because a digit is easy to
 * alter and hard to dispute. Lakh and crore rather than million and billion:
 * this reads to the people who actually receive these documents.
 */
export function paiseToWords(paise: Money, currency = "INR"): string {
  if (!Number.isFinite(paise)) throw new MoneyError("Cannot spell a non-finite amount.");

  const negative = paise < 0;
  const total = Math.abs(Math.round(paise));
  const rupees = Math.floor(total / PAISE_PER_RUPEE);
  const remainder = total % PAISE_PER_RUPEE;

  const unit = currency === "INR" ? "Rupees" : currency;
  const subUnit = currency === "INR" ? "Paise" : "Cents";

  const parts: string[] = [];
  // Indian grouping: crore, lakh, thousand, then the last three digits.
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1_000);
  const hundreds = rupees % 1_000;

  if (crore) parts.push(`${underThousand(crore)} Crore`);
  if (lakh) parts.push(`${underThousand(lakh)} Lakh`);
  if (thousand) parts.push(`${underThousand(thousand)} Thousand`);
  if (hundreds) parts.push(underThousand(hundreds));

  const rupeeWords = parts.length > 0 ? parts.join(" ") : "Zero";
  const paiseWords = remainder > 0 ? ` and ${underThousand(remainder)} ${subUnit}` : "";

  return `${negative ? "Minus " : ""}${unit} ${rupeeWords}${paiseWords} only`;
}
