import type { PaymentOrder } from "@prisma/client";

/**
 * What an organisation is shown of its own payment request.
 *
 * **Built field by field, never spread from the row.** The row also carries
 * the hash and the cipher of the six-digit code the platform owner issues
 * against an order, and typing that code back in approves the order. A bcrypt
 * hash of six digits is a million guesses on a laptop, so returning the row
 * from an organisation's endpoint was a way to approve your own order without
 * paying. A column added to `PaymentOrder` later stays on the server until it
 * is named here on purpose.
 *
 * Left out: the issued code and its cipher, who issued it and how many tries
 * it has had, the digits typed to confirm, who reviewed it, who raised it, the
 * coupon's id and the organisation's id. `reviewNote` and `infoRequestNote`
 * stay: they are the platform's message *to* the organisation (a rejection
 * reason, a question), written to be read by it.
 */
export interface CustomerOrder {
  id: string;
  orderNumber: string;
  status: PaymentOrder["status"];
  userCount: number;
  periodMonths: number;
  pricePerUserPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  payablePaise: number;
  couponCode: string | null;
  upiId: string;
  transactionRef: string | null;
  payerNote: string | null;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  infoRequestNote: string | null;
  expiresAt: Date;
  windowMinutes: number;
  createdAt: Date;
  updatedAt: Date;
  /** Whether the platform has issued a code against this order; never the code. */
  hasIssuedCode: boolean;
}

export function toCustomerOrder(order: PaymentOrder): CustomerOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    userCount: order.userCount,
    periodMonths: order.periodMonths,
    pricePerUserPaise: order.pricePerUserPaise,
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    payablePaise: order.payablePaise,
    couponCode: order.couponCode,
    upiId: order.upiId,
    transactionRef: order.transactionRef,
    payerNote: order.payerNote,
    submittedAt: order.submittedAt,
    reviewedAt: order.reviewedAt,
    reviewNote: order.reviewNote,
    infoRequestNote: order.infoRequestNote,
    expiresAt: order.expiresAt,
    windowMinutes: order.windowMinutes,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    hasIssuedCode: order.issuedCodeHash != null,
  };
}

/**
 * The platform owner's view of an order: everything on the row except the
 * issued code itself.
 *
 * The superadmin already has `reveal_code` for reading back a code they
 * issued, on purpose and one at a time. Shipping the hash and the cipher with
 * every order detail and every review action put them in browser memory, dev
 * tools and any proxy log on the way for no reason; `hasIssuedCode` is what the
 * screens actually use.
 */
export function withoutIssuedCode<T extends Pick<PaymentOrder, "issuedCodeHash" | "issuedCodeCipher">>(
  order: T,
): Omit<T, "issuedCodeHash" | "issuedCodeCipher"> & { hasIssuedCode: boolean } {
  const { issuedCodeHash, issuedCodeCipher: _cipher, ...rest } = order;
  return { ...rest, hasIssuedCode: issuedCodeHash != null };
}
