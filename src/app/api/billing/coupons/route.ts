import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { listCheckoutCoupons } from "@/services/billing/orders";

/**
 * The offers this organisation can see while buying seats.
 *
 * A `GET`, because it writes nothing and the seat selector calls it again every
 * time the buyer changes how many seats they want -- whether a coupon applies
 * depends on that number, and a list that did not follow it would show a 50-seat
 * offer as available to somebody buying ten.
 *
 * Scoped in the service, not here: only coupons somebody deliberately published,
 * and a coupon tied to one organisation is returned only to that organisation.
 */
const querySchema = z.object({
  userCount: z.coerce.number().int().min(1).max(10_000).catch(1),
});

export const GET = route(async (request) => {
  const ctx = await requireContext();
  const { userCount } = querySchema.parse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  return json({ coupons: await listCheckoutCoupons(ctx, { userCount }) });
});
