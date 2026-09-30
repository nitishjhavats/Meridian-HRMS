import { prisma } from "@/lib/db/prisma";
import { organizationLogoDataUri } from "./orgLogo";
import {
  identifiersFor,
  resolveDocumentIdentifiers,
  type DocumentKind,
} from "@/domain/org/documentIdentifiers";

/**
 * The block at the top of every document an organisation issues.
 *
 * One builder, so a letter, a payslip and a full-and-final statement carry the
 * same letterhead. They did not before: each composed its own address from five
 * of the seven fields, `country` was left out of both — so a letterhead could
 * never say "India" — and the statutory identifiers were fetched by neither.
 * `slips.ts` did not even select them.
 *
 * The identifiers are chosen **per identifier and per document**. One boolean
 * for all six across all three was wrong in both directions: a payslip is a tax
 * record and wants the PAN and the PF code on it, while an offer letter with
 * both across the top reads like a tax notice. Blank values are never printed
 * either way, so choosing to show a GSTIN you do not have shows nothing.
 */

export interface DocumentHeader {
  name: string;
  /** The registered address on one line, `country` included. */
  address: string | null;
  /** Phone, email and website, whichever exist. */
  contact: string | null;
  /** CIN, GSTIN and the rest — null unless this document was asked to carry them. */
  statutory: string | null;
  logoDataUri: string | null;
  /**
   * The organisation's mark, for whatever number this document carries.
   *
   * Here because every caller that draws a letterhead also prints a number
   * beside it, and reading the prefix separately meant a second query for a
   * field the header row already had in hand.
   */
  codePrefix: string;
}

export async function documentHeader(
  organizationId: string | null,
  /**
   * Which document this is for.
   *
   * Defaulted so the three existing callers did not all have to change in the
   * same commit as the schema, and because a caller that has not thought about
   * it should get the most conservative answer -- a letter, the document where
   * an unwanted tax number looks most out of place.
   */
  kind: DocumentKind = "letter",
): Promise<DocumentHeader | null> {
  if (!organizationId) return null;

  const [org, logoDataUri] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        name: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        phone: true,
        email: true,
        website: true,
        showStatutoryOnDocuments: true,
        documentIdentifiers: true,
        cin: true,
        gstin: true,
        panNumber: true,
        tan: true,
        pfCode: true,
        esiCode: true,
        employeeCodePrefix: true,
      },
    }),
    organizationLogoDataUri(organizationId),
  ]);
  if (!org) return null;

  const address =
    [org.addressLine1, org.addressLine2, org.city, org.state, org.postalCode, org.country]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(", ") || null;

  const contact =
    [org.phone, org.email, org.website]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join("  ·  ") || null;

  const chosen = resolveDocumentIdentifiers(
    org.documentIdentifiers,
    org.showStatutoryOnDocuments,
  );
  const statutory =
    identifiersFor(kind, chosen, {
      cin: org.cin,
      gstin: org.gstin,
      panNumber: org.panNumber,
      tan: org.tan,
      pfCode: org.pfCode,
      esiCode: org.esiCode,
    })
      .map(({ label, value }) => `${label} ${value}`)
      .join("  ·  ") || null;

  return {
    name: org.name,
    address,
    contact,
    statutory,
    logoDataUri,
    codePrefix: org.employeeCodePrefix,
  };
}
