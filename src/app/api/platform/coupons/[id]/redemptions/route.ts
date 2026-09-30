import { json, route } from "@/lib/http/handler";
import { getCouponRedemptions } from "@/services/platform/coupons";

/**
 * Who used a coupon.
 *
 * The list showed the count and nothing else, so "twelve redemptions" could not
 * be turned into twelve organisations — which is the only question a count
 * leads to.
 */
export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ redemptions: await getCouponRedemptions(ctx, params.id) });
});
