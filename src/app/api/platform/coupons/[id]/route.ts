import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, noContent, parseBody, route } from "@/lib/http/handler";
import { deactivateCoupon, updateCoupon } from "@/services/platform/coupons";

const patchSchema = z.object({
  description: z.string().trim().max(200).optional(),
  percent: z.number().min(0.01).max(100).optional(),
  maxDiscountPaise: z.number().int().min(0).nullable().optional(),
  startsAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  // zod strips what it does not declare, so a field missing here arrives as
  // undefined and the setting saves while doing nothing at all.
  maxPerOrganisation: z.number().int().min(1).nullable().optional(),
  minUserCount: z.number().int().min(1).nullable().optional(),
  maxUserCount: z.number().int().min(1).nullable().optional(),
  firstPurchaseOnly: z.boolean().optional(),
  listed: z.boolean().optional(),
  appliesToOrgId: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

export const PATCH = route<{ id: string }>(async (request, { params }) => {
  const ctx = await requireContext();
  const body = await parseBody(request, patchSchema);
  return json({ coupon: await updateCoupon(ctx, params.id, body) });
});

export const DELETE = route<{ id: string }>(async (_request, { params }) => {
  const ctx = await requireContext();
  await deactivateCoupon(ctx, params.id);
  return noContent();
});
