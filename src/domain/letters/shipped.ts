import { defaultFramework } from "./defaults";
import type { LetterCategory } from "./template";

/**
 * Whether a saved letter body is a copy of something the product shipped.
 *
 * **Why this question exists.** `LetterTemplate.title` and `bodyTemplate` used
 * to be NOT NULL, and uploading a signature has to create a row — so the code
 * filled them by copying the built-in text of that day. An organisation that
 * had customised nothing ended up with a row that said it had, frozen against
 * every later improvement to the shipped wording.
 *
 * The columns are nullable now, so new rows carry no text at all. This is for
 * the rows already out there: it recognises a body nobody actually wrote, so
 * the bulk script can free it and the template editor can say so on screen.
 *
 * It lives in the domain because both of those need the same answer, and a
 * bulk migration disagreeing with what the product shows somebody is worse than
 * either being wrong on its own.
 */

/** The sign-off exactly as it was appended before round 3. */
const OLD_SIGN_OFF = [
  "Yours sincerely,",
  "",
  "{{signatory.name}}",
  "{{signatory.title}}",
  "{{organization.name}}",
].join("\n");

/** What the same body ends with now. */
const NEW_SIGN_OFF = "Yours sincerely,";

/**
 * Every shipped body a stored row could be holding a copy of.
 *
 * Today's, and the same text with the old sign-off block put back — which is
 * what a row frozen before round 3 contains.
 *
 * Bodies that were also *rewritten* in round 3 rather than merely re-signed
 * will not appear here, and are correctly treated as customised. This
 * deliberately claims only the certainty it has: the cost of a false positive
 * is replacing wording somebody chose for a document they issue to their own
 * staff, and the cost of a false negative is a notice that does not appear.
 */
export function shippedBodies(category: LetterCategory): string[] {
  const current = defaultFramework(category)?.body;
  if (!current) return [];

  const bodies = [current];
  if (current.endsWith(NEW_SIGN_OFF)) {
    bodies.push(current.slice(0, -NEW_SIGN_OFF.length) + OLD_SIGN_OFF);
  }
  return bodies;
}

/**
 * True when this saved body is one the product shipped, rather than one
 * somebody wrote.
 *
 * `null` — no saved body — is not shipped text; it means the row never
 * overrode the wording in the first place, which is a different state and the
 * caller should not be told they are the same.
 */
export function isShippedBody(category: LetterCategory, body: string | null): boolean {
  if (body === null) return false;
  return shippedBodies(category).includes(body);
}
