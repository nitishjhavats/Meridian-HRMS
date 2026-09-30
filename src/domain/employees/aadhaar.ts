/**
 * Aadhaar, reduced to its last four digits.
 *
 * Since *Puttaswamy*, a private company's use of Aadhaar is heavily restricted,
 * and holding the full twelve digits carries obligations — and a breach
 * exposure — that holding four does not. Four is enough to confirm which number
 * an employee means when they are asked; it is not enough to be used as an
 * identity anywhere.
 *
 * This product used to store the whole number, encrypted. That was flagged as a
 * decision rather than a bug, and the decision was taken: last four only, for
 * new entries and for the ones already stored.
 *
 * Pure, so the migration script and the write path cannot disagree about what
 * "the last four" means.
 */

/** Digits only, so spaces and dashes in a typed number do not change the answer. */
export function aadhaarDigits(input: string): string {
  return input.replace(/\D/g, "");
}

/**
 * The last four digits, or null when there is nothing usable.
 *
 * A number with fewer than four digits is not a partial Aadhaar, it is a typo,
 * and storing it would put something in the field that looks like data.
 */
export function aadhaarLastFour(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = aadhaarDigits(input);
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/** Whether a value is already reduced — used to keep the migration idempotent. */
export function isAadhaarLastFour(value: string | null | undefined): boolean {
  return typeof value === "string" && /^\d{4}$/.test(value);
}
