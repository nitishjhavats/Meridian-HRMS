import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { getOrganizationProfile, updateOrganizationProfile } from "@/services/org/profile";
import { documentIdentifiersSchema } from "@/domain/org/documentIdentifiers";

/**
 * The organisation's own details.
 *
 * Nothing has ever written these from inside the product — the address a letter
 * prints came from whatever the organisation was created with, and the
 * statutory identifiers had nowhere to live at all.
 */
const text = z.string().trim().max(200).optional().nullable();

const bodySchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  legalName: text,
  email: text,
  phone: text,
  website: text,
  addressLine1: text,
  addressLine2: text,
  city: text,
  state: text,
  postalCode: text,
  // Editable at last. It has always been on the row, always printed on the
  // letterhead, and had no field anywhere in the product — so an organisation
  // outside India could not correct it.
  country: text,
  /** Who signs the letters. The image itself uploads separately. */
  signatoryName: text,
  signatoryTitle: text,
  cin: text,
  gstin: text,
  panNumber: text,
  tan: text,
  pfCode: text,
  esiCode: text,
  probationDays: z.number().int().min(0).max(730).optional(),
  trainingDays: z.number().int().min(0).max(730).optional(),
  // Shape is checked in the domain, which owns the message people read.
  employeeCodePrefix: z.string().trim().max(8).optional(),
  showStatutoryOnDocuments: z.boolean().optional(),
  documentIdentifiers: documentIdentifiersSchema.optional(),
});

export const GET = route(async (_request, { ctx }) => {
  return json({ profile: await getOrganizationProfile(ctx) });
});

export const PATCH = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);
  return json({ profile: await updateOrganizationProfile(ctx, body) });
});
