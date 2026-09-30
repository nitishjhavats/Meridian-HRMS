/**
 * Which encrypted columns an export is allowed to read back, and under what
 * name.
 *
 * The export redacts by *pattern* — anything whose column name matches
 * `/(cipher|hash|secret|token|password|descriptor)/i` is written as
 * "[redacted]" — and that rule is the reason a column added to the schema next
 * month is safe on the day it appears rather than the day somebody remembers
 * this file. Nothing here weakens it. This is a short, explicit list of
 * exceptions, and everything not on it stays redacted exactly as before.
 *
 * The exceptions exist because of what an export is *for*. An organisation
 * leaving this product has to be able to pay its staff on the other side, and a
 * payroll file without bank accounts is a list of names. The alternative that
 * was considered and rejected was a second, separately-authorised export
 * carrying only these fields; it is more careful and it is one more thing to
 * get right at the worst possible moment.
 *
 * Two rules decide what is on the list:
 *
 *   1. It has to be a **fact about the employee that another payroll needs** —
 *      how to pay them, and the statutory identifiers a payroll must file
 *      against. Not a credential.
 *   2. It must not be **health data**. Blood group is encrypted beside the bank
 *      details and is deliberately absent: it is not needed to run payroll, and
 *      it carries obligations the rest of this list does not.
 *
 * A password hash, a TOTP secret, an export's own passphrase and a face
 * descriptor all fail the first rule, which is why none of them appear here and
 * why adding one should feel like the deliberate act it would be.
 */

/** The readable name each revealed column takes in the export. */
export const REVEALED_IDENTIFIERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  employee: {
    panCipher: "pan",
    uanCipher: "uan",
    bankNameCipher: "bankName",
    bankAccountCipher: "bankAccount",
    bankIfscCipher: "bankIfsc",
    // Only the last four digits exist. The rest is discarded at write time
    // under the Aadhaar Act, so this is not a choice the export gets to make.
    aadhaarCipher: "aadhaarLastFour",
  },
};

/**
 * The name this column takes when read back, or null to leave it redacted.
 *
 * Model-scoped, so a `panCipher` appearing on some future table is redacted
 * until somebody decides otherwise here.
 */
export function revealedAs(model: string, column: string): string | null {
  return REVEALED_IDENTIFIERS[model]?.[column] ?? null;
}

/** Every model that has at least one revealed column. */
export function modelsWithRevealedIdentifiers(): string[] {
  return Object.keys(REVEALED_IDENTIFIERS);
}

/**
 * What the archive's own README has to say about it.
 *
 * Kept beside the list rather than in the export service, because the sentence
 * and the list are the same decision: an archive that quietly holds every bank
 * account in the organisation should say so on its first page.
 */
export const IDENTIFIER_NOTICE = [
  "This archive contains readable statutory and bank identifiers: PAN, UAN,",
  "bank name, bank account number and IFSC, for every employee. They are",
  "encrypted in the database and are decrypted here because a payroll migration",
  "cannot be done without them.",
  "",
  "Aadhaar appears as the last four digits only. The rest of the number is",
  "discarded when it is entered and no copy of it exists anywhere in this",
  "product.",
  "",
  "Treat this file as you would the bank mandate it replaces.",
];
