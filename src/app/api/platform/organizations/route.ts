import { z } from "zod";
import { isValidTimeZone } from "@/domain/date";
import { requireContext } from "@/lib/auth/context";
import { created, json, parseBody, parseQuery, route } from "@/lib/http/handler";
import {
  createOrganization,
  listOrganizations,
  listOrganizationsPage,
} from "@/services/platform/organizations";
import { MODULE_KEYS } from "@/lib/features";

const querySchema = z.object({
  search: z.string().optional(),
  /**
   * Present only when the caller wants a page.
   *
   * Absent keeps the original shape — `{ organizations: [...] }`, everything —
   * because the full-page list has always relied on it and paging a list that
   * fits on one screen would be a change nobody asked for.
   */
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  status: z
    .string()
    .optional()
    .transform((v) => (v ? (v.split(",") as never[]) : undefined)),
});

export const GET = route(async (request) => {
  const ctx = await requireContext();
  const filters = parseQuery(request, querySchema);
  if (filters.page !== undefined) {
    return json(await listOrganizationsPage(ctx, filters));
  }
  return json({ organizations: await listOrganizations(ctx, filters) });
});

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(160).optional(),
  slug: z.string().trim().min(3).max(50),
  employeeCodePrefix: z.string().trim().max(8).optional(),
  email: z.string().trim().email().optional().or(z.literal("")),
  phone: z.string().trim().max(32).optional(),
  website: z.string().trim().max(200).optional(),
  industry: z.string().trim().max(80).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  country: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(16).optional(),
  timezone: z
    .string()
    .trim()
    .max(64)
    .refine(isValidTimeZone, "That is not a timezone Intl recognises (for example Asia/Kolkata).")
    .optional(),
  currency: z.string().trim().length(3).optional(),
  // All three optional: the Superadmin may settle commercials now, or leave them
  // to the organisation's own admin. `seats: 0` is a deliberate, meaningful
  // value — no seats yet — not a validation failure.
  seats: z.number().int().min(0).max(10_000).optional(),
  billingMode: z.enum(["TRIAL", "PAID", "FREE_INTERNAL"]).optional(),
  billingCycle: z.enum(["MONTHLY", "QUARTERLY", "HALF_YEARLY", "ANNUAL"]).optional(),
  trialDays: z.number().int().min(1).max(365).optional(),
  alreadyPaid: z.boolean().optional(),
  grantedModules: z.array(z.enum(MODULE_KEYS as [string, ...string[]])).optional(),
  owner: z.object({
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email(),
    phone: z.string().trim().max(32).optional(),
  }),
  workingHours: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      breakMinutes: z.number().int().min(0).max(240),
    })
    .optional(),
  weeklyOffDays: z.array(z.number().int().min(0).max(6)).optional(),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, createSchema);
  const result = await createOrganization(ctx, body as never);
  // The temporary password is shown once, here, and never stored in the clear.
  return created(result);
});
