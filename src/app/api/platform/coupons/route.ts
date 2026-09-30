import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { created, json, parseBody, route } from "@/lib/http/handler";
import { createCoupon, listCoupons } from "@/services/platform/coupons";

export const GET = route(async () => {
  const ctx = await requireContext();
  return json({ coupons: await listCoupons(ctx) });
});

const createSchema = z.object({
  code: z.string().trim().max(32).optional(),
  description: z.string().trim().max(200).optional(),
  percent: z.number().min(0.01).max(100),
  maxDiscountPaise: z.number().int().min(0).nullable().optional(),
  startsAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
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

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, createSchema);
  return created({ coupon: await createCoupon(ctx, body) });
});
