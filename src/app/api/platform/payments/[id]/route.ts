import { json, route } from "@/lib/http/handler";
import { getOrderDetail } from "@/services/platform/payments";

/**
 * One payment request, with the events behind it.
 *
 * `getOrderDetail` was written, tested and reachable from nothing: the payments
 * list showed a status and a total, and the timeline of how an order got there —
 * raised, code issued, UTR entered, confirmed — existed only in the database.
 * When a customer rings to ask why their payment has not gone through, that
 * timeline is the answer.
 */
export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ order: await getOrderDetail(ctx, params.id) });
});
