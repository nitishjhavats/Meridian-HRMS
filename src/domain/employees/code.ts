/**
 * Employee codes.
 *
 * Every organisation numbers its own people: three letters it chooses when it
 * is created, then a zero-padded serial. Before this, the prefix was *inferred*
 * from whichever existing code happened to have the highest numeric tail — so a
 * directory holding two patterns inherited the wrong one, and a brand-new
 * organisation was handed `EMP001`, which meant every customer's staff were
 * numbered as though they all worked for the same company.
 *
 * Pure: no database, no clock. The service supplies the organisation's prefix
 * and the highest serial in use.
 */

export const DEFAULT_CODE_PREFIX = "EMP";

/** Zero-padding width for the serial. `ACM007`, not `ACM7`. */
export const CODE_DIGITS = 3;

export class InvalidCodePrefix extends Error {}

/**
 * Three or four letters, upper-cased.
 *
 * Four, because three is not enough to squeeze a real company name into
 * something its own staff recognise: "Jivonik Ayurveda" is JVNK and "KamaWell"
 * is KMWL, and both lose their shape at three. Five would start to be a word
 * rather than a mark.
 *
 * Letters only, deliberately: a digit in the prefix makes `ACM2024001`
 * ambiguous about where the prefix stops and the serial starts, and the serial
 * is what has to be read back out to find the next one.
 */
export function normaliseCodePrefix(input: string): string {
  const prefix = input.trim().toUpperCase();
  if (!/^[A-Z]{3,4}$/.test(prefix)) {
    throw new InvalidCodePrefix("A code prefix is three or four letters, A to Z.");
  }
  return prefix;
}

/** Whether a string would be accepted, without throwing. Used by forms. */
export function isValidCodePrefix(input: string): boolean {
  try {
    normaliseCodePrefix(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * A starting suggestion for a new organisation, from its name.
 *
 * **Consonants, not the first three letters.** "Jivonik Ayurveda" gives JVNK
 * and "KamaWell Ayurveda" gives KMWL -- which is how a person shortens a name
 * when they have to, and how these two were chosen by hand before this existed.
 * Taking the first letters instead gives JIV and KAM, which are the start of a
 * word rather than a mark for it.
 *
 * Vowels are dropped after the first letter, never before it: a name beginning
 * with one keeps it, or "Acme" would suggest CM.
 *
 * Falls back to whatever letters there are when the squeeze leaves too few --
 * "Ao Ltd" has two usable consonants -- and to the shipped default when there
 * are none at all. Always shown and always editable: it is a suggestion, not a
 * decision.
 */
export function suggestCodePrefix(organizationName: string): string {
  const letters = organizationName.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (letters.length === 0) return DEFAULT_CODE_PREFIX;

  const first = letters[0]!;
  const squeezed = first + letters.slice(1).replace(/[AEIOU]/g, "");

  // Four when the name gives four, three when it gives three, and the plain
  // letters when the squeeze has left fewer than a prefix needs.
  const source = squeezed.length >= 3 ? squeezed : letters;
  return source.slice(0, 4).padEnd(3, "X");
}

/** `ACM` + 42 → `ACM042`. Past the padding width the number simply gets longer. */
export function formatEmployeeCode(prefix: string, serial: number): string {
  return `${normaliseCodePrefix(prefix)}${String(serial).padStart(CODE_DIGITS, "0")}`;
}

/**
 * The serial in a code, or null when there is not one.
 *
 * Only a code that actually belongs to this prefix counts: `ACM007` under
 * prefix `ACM` is 7, but under prefix `BRI` it is nothing, or renumbering one
 * organisation would read another's series.
 */
export function serialFor(code: string, prefix: string): number | null {
  const match = new RegExp(`^${normaliseCodePrefix(prefix)}([0-9]+)$`).exec(code.trim().toUpperCase());
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}
