import { z } from "zod";
import { isValidTimeZone } from "@/domain/date";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { getOrganization, updateOrganization } from "@/services/platform/organizations";

export const GET = route<{ id: string }>(async (_request, { params }) => {
  const ctx = await requireContext();
  return json(await getOrganization(ctx, params.id));
});

/**
 * Everything the platform owner may change after creation.
 *
 * The service has always accepted every Organization column; this schema is
 * what actually reached it, and it stopped at eleven fields -- so a name, an
 * address, a statutory identifier or the slug could be set at creation and
 * never corrected. An empty string clears an optional field rather than
 * writing "", which is what the organisation's own profile form already does.
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const patchSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  legalName: optionalText(160),
  // Changes `/o/<slug>`. Validated and uniqueness-checked in the service.
  slug: z.string().trim().min(3).max(50).optional(),
  email: z
    .union([z.string().trim().email().max(200), z.literal("")])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional(),
  phone: optionalText(32),
  website: optionalText(200),
  industry: optionalText(80),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  // Non-nullable in the schema, with a default of "India", so it is set or left alone.
  country: z.string().trim().min(1).max(80).optional(),
  postalCode: optionalText(16),
  cin: optionalText(64),
  gstin: optionalText(64),
  panNumber: optionalText(32),
  tan: optionalText(32),
  pfCode: optionalText(64),
  esiCode: optionalText(64),
  timezone: z
    .string()
    .trim()
    .max(64)
    .refine(isValidTimeZone, "That is not a timezone Intl recognises (for example Asia/Kolkata).")
    .optional(),
  currency: z.string().trim().length(3).optional(),
  probationDays: z.number().int().min(0).max(730).optional(),
  trainingDays: z.number().int().min(0).max(730).optional(),
  employeeCodePrefix: z.string().trim().max(8).optional(),
  seats: z.number().int().min(0).max(10_000).optional(),
});

export const PATCH = route<{ id: string }>(async (request, { params }) => {
  const ctx = await requireContext();
  const body = await parseBody(request, patchSchema);
  return json({ organization: await updateOrganization(ctx, params.id, body) });
});
