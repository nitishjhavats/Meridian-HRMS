import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite } from "@/lib/auth/guard";
import {
  documentIdentifiersSchema,
  resolveDocumentIdentifiers,
  type DocumentIdentifiers,
} from "@/domain/org/documentIdentifiers";
import { writeAudit } from "@/lib/audit";
import { ValidationError } from "@/lib/errors";
import { normaliseCodePrefix } from "@/domain/employees/code";

/**
 * The organisation's own details — address, contact, and the statutory
 * identifiers that letters have to quote.
 *
 * These columns existed for the address and were added for the identifiers, and
 * nothing has ever written any of them from inside the product: the address a
 * letter prints came from whatever `provisionTenant` was given at creation, and
 * a CIN or GSTIN had nowhere to live at all. So an appointment letter that has
 * to carry a corporate identity number could not, and correcting a typo in the
 * registered address meant editing the database.
 *
 * Validation is deliberately light. These are identifiers issued by several
 * different authorities in formats that change, and refusing a legitimate one
 * because a regex is out of date is worse than storing a wrong one an
 * administrator can see and fix. Length and whitespace only.
 */

export interface OrganizationProfile {
  name: string;
  /** The company seal, printed beside the signature on a letter. */
  stampKey?: string | null;
  stampUrl?: string | null;
  signatureUrl?: string | null;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  cin: string | null;
  gstin: string | null;
  panNumber: string | null;
  tan: string | null;
  pfCode: string | null;
  esiCode: string | null;
  /** Days a new hire stays on probation by default. */
  probationDays: number;
  /** Days a new hire stays in training, when they start there. */
  trainingDays: number;
  /** The three letters every employee code here starts with. */
  employeeCodePrefix: string;
  /**
   * The old single switch, kept as the fallback for anyone who has not opened
   * the new matrix. On meant all six identifiers on every document.
   */
  showStatutoryOnDocuments: boolean;
  /** Which identifiers print on which document. */
  documentIdentifiers: DocumentIdentifiers;
}

const FIELDS = [
  "legalName",
  "email",
  "phone",
  "website",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  // `country` has always been on the row, always printed on the letterhead, and
  // has never had a field anywhere in the product — so an organisation outside
  // India could not correct the one line of its own address that was wrong.
  "country",
  "signatoryName",
  "signatoryTitle",
  "cin",
  "gstin",
  "panNumber",
  "tan",
  "pfCode",
  "esiCode",
] as const;

export async function getOrganizationProfile(ctx: AuthContext): Promise<OrganizationProfile> {
  requireOrg(ctx);

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId! },
    select: {
      name: true,
      employeeCodePrefix: true,
      trainingDays: true,
      showStatutoryOnDocuments: true,
      documentIdentifiers: true,
      legalName: true,
      email: true,
      phone: true,
      website: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      signatoryName: true,
      signatoryTitle: true,
      cin: true,
      gstin: true,
      panNumber: true,
      tan: true,
      pfCode: true,
      esiCode: true,
      probationDays: true,
      stampKey: true,
      signatureKey: true,
    },
  });

  // A URL, not the key: the screen renders it in an <img>, and `/api/files` is
  // the only way anything in storage is readable.
  return {
    ...org,
    stampUrl: org.stampKey ? `/api/files/${org.stampKey}` : null,
    signatureUrl: org.signatureKey ? `/api/files/${org.signatureKey}` : null,
    // Resolved here so every caller sees the same shape, whether the row holds
    // a matrix, holds nothing, or holds something that will not parse.
    documentIdentifiers: resolveDocumentIdentifiers(
      org.documentIdentifiers,
      org.showStatutoryOnDocuments,
    ),
  };
}

export async function updateOrganizationProfile(
  ctx: AuthContext,
  input: Partial<Record<(typeof FIELDS)[number], string | null>> & {
    name?: string;
    probationDays?: number;
    trainingDays?: number;
    employeeCodePrefix?: string;
    showStatutoryOnDocuments?: boolean;
    documentIdentifiers?: DocumentIdentifiers;
  },
): Promise<OrganizationProfile> {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const before = await getOrganizationProfile(ctx);

  const data: Record<string, string | number | boolean | null | Prisma.InputJsonValue> = {};

  if (input.probationDays !== undefined) {
    const days = Math.round(input.probationDays);
    // A year is already unusual; beyond that somebody has typed a date into a
    // day count. Zero means "no probation", which is a legitimate choice.
    if (!Number.isFinite(days) || days < 0 || days > 730) {
      throw new ValidationError("A probation period is between 0 and 730 days.");
    }
    data.probationDays = days;
  }

  if (input.trainingDays !== undefined) {
    const days = Math.round(input.trainingDays);
    if (!Number.isFinite(days) || days < 0 || days > 730) {
      throw new ValidationError("A training period is between 0 and 730 days.");
    }
    data.trainingDays = days;
  }

  if (input.showStatutoryOnDocuments !== undefined) {
    data.showStatutoryOnDocuments = input.showStatutoryOnDocuments;
  }

  if (input.documentIdentifiers !== undefined) {
    // Parsed rather than trusted: this arrives from a form, and an unknown key
    // in it would print a label nothing can resolve.
    const parsed = documentIdentifiersSchema.safeParse(input.documentIdentifiers);
    if (!parsed.success) throw new ValidationError("That is not a valid choice of identifiers.");
    data.documentIdentifiers = parsed.data;
    // The matrix is now the answer, so the old switch stops competing with it.
    // Leaving it true would make `resolveDocumentIdentifiers` fall back to all
    // six the first time the matrix failed to parse.
    data.showStatutoryOnDocuments = false;
  }

  if (input.employeeCodePrefix !== undefined) {
    // Throws its own message, which says exactly what is wrong. Changing this
    // does not touch anybody's existing code -- only what the next one, and a
    // deliberate renumber, will use.
    data.employeeCodePrefix = normaliseCodePrefix(input.employeeCodePrefix);
  }

  if (input.name !== undefined) {
    const name = input.name.trim();
    // The name is on the sign-in page, the app shell and every letter. An empty
    // one would leave people looking at a blank where their company should be.
    if (name.length < 2) throw new ValidationError("The organisation needs a name.");
    data.name = name;
  }

  for (const field of FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    const trimmed = (value ?? "").trim();
    if (trimmed.length > 200) {
      throw new ValidationError(`That ${field} is too long.`);
    }
    data[field] = trimmed || null;
  }

  if (Object.keys(data).length === 0) return before;

  await prisma.organization.update({ where: { id: ctx.organizationId! }, data });
  const after = await getOrganizationProfile(ctx);

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    // Only what moved, so the log reads as a change rather than a snapshot.
    before: Object.fromEntries(
      Object.keys(data).map((k) => [k, before[k as keyof OrganizationProfile]]),
    ),
    after: Object.fromEntries(
      Object.keys(data).map((k) => [k, after[k as keyof OrganizationProfile]]),
    ),
  });

  return after;
}
