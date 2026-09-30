/**
 * Seat pricing and coupon validation.
 *
 * The price per user lives in `PlatformSetting` and is passed in — there is no
 * price literal anywhere in the codebase. Every amount is recomputed on the
 * server at order creation *and* again at approval; a client-submitted total is
 * never trusted.
 */

import { type Money, pct, roundHalfUp } from "../money";

export interface CouponSpec {
  code: string;
  /** 0–100, may be fractional. */
  percent: number;
  /** Optional cap on the rupee value of the discount. */
  maxDiscountPaise?: number | null;
  startsAt: Date;
  expiresAt: Date;
  /** Total uses across everybody. Null = unlimited. */
  maxRedemptions?: number | null;
  redemptionCount: number;
  /**
   * Uses by one organisation. Null = as often as they like.
   *
   * Separate from `maxRedemptions` on purpose: without it a single buyer could
   * spend a hundred-use launch coupon on its own renewals and nobody else would
   * ever see the offer.
   */
  maxPerOrganisation?: number | null;
  minUserCount?: number | null;
  maxUserCount?: number | null;
  /** Only for a buyer who has never had an order approved. */
  firstPurchaseOnly?: boolean;
  /** null = usable by any organisation. */
  appliesToOrgId?: string | null;
  active: boolean;
}

export type CouponRejection =
  | "NOT_FOUND"
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "EXHAUSTED"
  | "USER_COUNT_TOO_LOW"
  | "USER_COUNT_TOO_HIGH"
  | "ALREADY_USED"
  | "NOT_FIRST_PURCHASE"
  | "WRONG_ORGANISATION";

export interface CouponCheck {
  ok: boolean;
  reason?: CouponRejection;
  message?: string;
}

const COUPON_MESSAGES: Record<CouponRejection, string> = {
  NOT_FOUND: "That coupon code does not exist.",
  INACTIVE: "That coupon is no longer active.",
  NOT_STARTED: "That coupon is not valid yet.",
  EXPIRED: "That coupon has expired.",
  EXHAUSTED: "That coupon has reached its usage limit.",
  USER_COUNT_TOO_LOW: "That coupon needs a larger number of users.",
  USER_COUNT_TOO_HIGH: "That coupon does not apply to this many users.",
  ALREADY_USED: "You have already used that coupon as many times as it allows.",
  NOT_FIRST_PURCHASE: "That coupon is for a first purchase only.",
  WRONG_ORGANISATION: "That coupon is not available for this organisation.",
};

/**
 * What the buyer's own history says about this coupon.
 *
 * Two facts the coupon row cannot hold, because they are about the buyer and
 * not about the offer. Both default to the permissive answer, so a caller that
 * does not know them yet behaves exactly as it did before these existed --
 * which matters, because `validateCoupon` runs at quote time, at order time and
 * again at approval, and a caller left behind would silently start refusing.
 */
export interface CouponHistory {
  /** How many times this organisation has already redeemed this coupon. */
  organizationRedemptions?: number;
  /** Whether this organisation has ever had an order approved. */
  hasPurchasedBefore?: boolean;
}

export function validateCoupon(
  coupon: CouponSpec | null | undefined,
  context: { userCount: number; organizationId: string; now: Date } & CouponHistory,
): CouponCheck {
  const reject = (reason: CouponRejection): CouponCheck => ({
    ok: false,
    reason,
    message: COUPON_MESSAGES[reason],
  });

  if (!coupon) return reject("NOT_FOUND");
  if (!coupon.active) return reject("INACTIVE");
  if (context.now < coupon.startsAt) return reject("NOT_STARTED");
  if (context.now > coupon.expiresAt) return reject("EXPIRED");
  if (coupon.maxRedemptions != null && coupon.redemptionCount >= coupon.maxRedemptions) {
    return reject("EXHAUSTED");
  }
  if (coupon.minUserCount != null && context.userCount < coupon.minUserCount) {
    return reject("USER_COUNT_TOO_LOW");
  }
  if (coupon.maxUserCount != null && context.userCount > coupon.maxUserCount) {
    return reject("USER_COUNT_TOO_HIGH");
  }
  if (
    coupon.maxPerOrganisation != null &&
    (context.organizationRedemptions ?? 0) >= coupon.maxPerOrganisation
  ) {
    return reject("ALREADY_USED");
  }
  if (coupon.firstPurchaseOnly && context.hasPurchasedBefore === true) {
    return reject("NOT_FIRST_PURCHASE");
  }
  if (coupon.appliesToOrgId != null && coupon.appliesToOrgId !== context.organizationId) {
    return reject("WRONG_ORGANISATION");
  }
  return { ok: true };
}

export interface OrderAmount {
  userCount: number;
  pricePerUserPaise: Money;
  subtotalPaise: Money;
  discountPaise: Money;
  payablePaise: Money;
  couponCode: string | null;
  couponPercent: number | null;
}

export interface QuoteInput {
  userCount: number;
  pricePerUserPaise: Money;
  coupon?: CouponSpec | null;
  /** Number of billing periods being purchased. */
  periods?: number;
}

export class PricingError extends Error {}

/**
 * The single place seat money is computed.
 *
 * `discount = subtotal × percent`, capped by `maxDiscountPaise`, and the discount
 * can never exceed the subtotal — a 150 % coupon still leaves the payable at zero
 * rather than turning into a refund.
 */
export function computeOrderAmount(input: QuoteInput): OrderAmount {
  const { userCount, pricePerUserPaise } = input;
  const periods = input.periods ?? 1;

  if (!Number.isInteger(userCount) || userCount < 1) {
    throw new PricingError("User count must be a whole number of at least 1.");
  }
  if (!Number.isInteger(pricePerUserPaise) || pricePerUserPaise < 0) {
    throw new PricingError("Price per user must be a whole number of paise.");
  }
  if (!Number.isInteger(periods) || periods < 1) {
    throw new PricingError("Billing periods must be a whole number of at least 1.");
  }

  const subtotalPaise = userCount * pricePerUserPaise * periods;

  let discountPaise = 0;
  if (input.coupon) {
    const raw = pct(subtotalPaise, input.coupon.percent);
    const capped =
      input.coupon.maxDiscountPaise != null ? Math.min(raw, input.coupon.maxDiscountPaise) : raw;
    discountPaise = Math.min(Math.max(0, capped), subtotalPaise);
  }

  return {
    userCount,
    pricePerUserPaise,
    subtotalPaise,
    discountPaise,
    payablePaise: subtotalPaise - discountPaise,
    couponCode: input.coupon?.code ?? null,
    couponPercent: input.coupon?.percent ?? null,
  };
}

/**
 * UPI deep link for the payment screen. The same string backs the QR code, so the
 * amount a payer sees in their UPI app is the one the server computed.
 */
export function buildUpiLink(params: {
  upiId: string;
  payeeName: string;
  amountPaise: Money;
  note: string;
  transactionRef?: string;
}): string {
  const amount = (params.amountPaise / 100).toFixed(2);
  const query = new URLSearchParams({
    pa: params.upiId,
    pn: params.payeeName,
    am: amount,
    cu: "INR",
    tn: params.note,
  });
  if (params.transactionRef) query.set("tr", params.transactionRef);
  return `upi://pay?${query.toString()}`;
}

/** Monthly recurring revenue for a set of paying subscriptions. */
export function computeMrr(
  subscriptions: readonly { seats: number; pricePerUserPaise: Money; billingMode: string }[],
): Money {
  return subscriptions
    .filter((s) => s.billingMode === "PAID")
    .reduce((acc, s) => acc + s.seats * s.pricePerUserPaise, 0);
}

export function averageRevenuePerOrg(totalPaise: Money, orgCount: number): Money {
  if (orgCount <= 0) return 0;
  return roundHalfUp(totalPaise / orgCount);
}
