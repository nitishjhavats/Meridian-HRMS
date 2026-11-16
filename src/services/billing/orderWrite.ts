import type { PaymentOrder, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

/**
 * Every change to a payment order is written only onto the row it was decided
 * on.
 *
 * Each transition is decided in code on a row read a moment earlier -- a
 * bcrypt compare, a coupon check, a person reading the queue -- and the write
 * used to be unconditional. Two requests on one order (the issued code typed
 * in two tabs, Approve pressed while the organisation resubmits, a stale
 * "ask for more information") could each write over the other: an APPROVED
 * order put back into the queue, and a second approval crediting it again.
 *
 * So the write is a compare-and-set on the status *and* `updatedAt` it was
 * decided on: one conditional UPDATE, which Postgres settles under its row
 * lock (the second writer waits, re-reads the row, and matches nothing).
 * `updatedAt` catches the round trip a status alone misses -- AWAITING, sent
 * back for information, resubmitted with a different reference, AWAITING
 * again. This is Prisma's documented optimistic-concurrency pattern
 * (`updateMany` with the version in `where`, then check `count`).
 *
 * Returns the row as written, or `null` when the order moved first; the caller
 * decides whether that is a repeat to answer quietly or a conflict to report.
 */
export async function writeOrderIfUnchanged(
  order: Pick<PaymentOrder, "id" | "status" | "updatedAt">,
  data: Prisma.PaymentOrderUpdateManyMutationInput,
  client: Prisma.TransactionClient = prisma,
): Promise<PaymentOrder | null> {
  const { count } = await client.paymentOrder.updateMany({
    where: { id: order.id, status: order.status, updatedAt: order.updatedAt },
    data,
  });
  if (count !== 1) return null;
  return client.paymentOrder.findUniqueOrThrow({ where: { id: order.id } });
}

export const ORDER_CHANGED_MESSAGE =
  "This payment request changed while you were working on it. Reload the page to see where it stands.";
