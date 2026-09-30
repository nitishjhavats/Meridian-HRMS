import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { created, json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { issueAdvanceCode, listPaymentCodes } from "@/services/platform/payments";

const listSchema = z.object({
  state: z.enum(["live", "used", "all"]).optional(),
});

export const GET = route(async (request) => {
  const ctx = await requireContext();
  const filters = parseQuery(request, listSchema);
  return json({ codes: await listPaymentCodes(ctx, filters) });
});

const issueSchema = z.object({
  organizationId: z.string().nullable().optional(),
  discountPercent: z.number().min(0).max(100).nullable().optional(),
  maxDiscountPaise: z.number().int().min(0).nullable().optional(),
  validDays: z.number().int().min(1).max(365).optional(),
  note: z.string().trim().max(200).nullable().optional(),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, issueSchema);
  // Returned once, to the platform owner, to pass on out of band.
  return created(await issueAdvanceCode(ctx, body));
});
