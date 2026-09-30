import { z } from "zod";

/**
 * Which statutory identifiers print on which document.
 *
 * There was one boolean — `showStatutoryOnDocuments` — and it produced one
 * pre-joined string, so every document that carried any identifier carried all
 * six. That is wrong in both directions in practice. A payslip is a tax record
 * and an employee needs the PAN and the PF establishment code on it; an offer
 * letter with a PF code and an ESI code across the top reads like a tax notice.
 * And a company that has a CIN but no GSTIN wants the one and not an empty
 * label for the other.
 *
 * So: six identifiers, three documents, and an organisation says which goes
 * where. Blank values are still never printed — choosing to show a GSTIN you do
 * not have shows nothing.
 */

export const IDENTIFIERS = [
  { key: "cin", label: "CIN", column: "cin", hint: "Corporate Identity Number" },
  { key: "gstin", label: "GSTIN", column: "gstin", hint: "GST registration" },
  { key: "pan", label: "PAN", column: "panNumber", hint: "Permanent Account Number" },
  { key: "tan", label: "TAN", column: "tan", hint: "Tax deduction account" },
  { key: "pf", label: "PF", column: "pfCode", hint: "EPF establishment code" },
  { key: "esi", label: "ESI", column: "esiCode", hint: "ESIC establishment code" },
] as const;

export type IdentifierKey = (typeof IDENTIFIERS)[number]["key"];

/** The three documents an organisation puts its name on. */
export const DOCUMENT_KINDS = ["payslip", "letter", "fnf"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  payslip: "Payslips",
  letter: "Letters",
  fnf: "Full and final statements",
};

const identifierKey = z.enum(
  IDENTIFIERS.map((i) => i.key) as unknown as [IdentifierKey, ...IdentifierKey[]],
);

export const documentIdentifiersSchema = z.object({
  payslip: z.array(identifierKey).default([]),
  letter: z.array(identifierKey).default([]),
  fnf: z.array(identifierKey).default([]),
});

export type DocumentIdentifiers = z.infer<typeof documentIdentifiersSchema>;

/** Nothing printed anywhere — what a new organisation gets. */
export const NO_IDENTIFIERS: DocumentIdentifiers = { payslip: [], letter: [], fnf: [] };

/** All six on all three — what the old boolean meant when it was on. */
export const ALL_IDENTIFIERS: DocumentIdentifiers = {
  payslip: IDENTIFIERS.map((i) => i.key),
  letter: IDENTIFIERS.map((i) => i.key),
  fnf: IDENTIFIERS.map((i) => i.key),
};

/**
 * Reads the stored choice, falling back to what the old boolean meant.
 *
 * The boolean is still the source for any organisation that has not touched the
 * new screen, so nothing changes under anybody the moment this ships: on meant
 * all six on every document, and that is exactly what they keep until they say
 * otherwise.
 */
export function resolveDocumentIdentifiers(
  stored: unknown,
  legacyShowAll: boolean,
): DocumentIdentifiers {
  const parsed = documentIdentifiersSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  return legacyShowAll ? ALL_IDENTIFIERS : NO_IDENTIFIERS;
}

/**
 * The identifiers to print on one document, as label/value pairs.
 *
 * Order follows `IDENTIFIERS` rather than the order somebody ticked the boxes,
 * so two documents from the same organisation never disagree about it. Empty
 * values are dropped here, which is why the caller cannot end up printing a
 * label with nothing after it.
 */
export function identifiersFor(
  kind: DocumentKind,
  chosen: DocumentIdentifiers,
  values: Partial<Record<string, string | null>>,
): { label: string; value: string }[] {
  const wanted = new Set(chosen[kind]);
  return IDENTIFIERS.flatMap((identifier) => {
    if (!wanted.has(identifier.key)) return [];
    const value = values[identifier.column]?.trim();
    return value ? [{ label: identifier.label, value }] : [];
  });
}
