/**
 * Codes the platform owner hands out in advance.
 *
 * An order-bound confirmation code already existed: the owner issues one
 * against a request that is sitting in the queue, and the organisation types
 * it in to say "this is the one". This is the other direction -- a code made
 * *before* there is an order, on the phone, for an organisation that has not
 * yet pressed Buy: "pay this much, here is your code". It may carry a discount,
 * it may be tied to one organisation or left open, and it is spent once.
 *
 * Pure. What a code is worth and whether it may be used are decided here from
 * the row and the order; the services read and write, the machine moves the
 * order, and neither of them repeats these rules.
 */

import { type Money, pct } from "../money";

export interface AdvanceCodeSpec {
  id: string;
  /** Null means any organisation may use it. */
  organizationId: string | null;
  /** 0-100, may be fractional. Null means the code confirms and discounts nothing. */
  discountPercent: number | null;
  maxDiscountPaise: number | null;
  expiresAt: Date;
  /** The order it was applied to at checkout or spent on at confirmation. */
  paymentOrderId: string | null;
  usedAt: Date | null;
  revokedAt: Date | null;
}

export type AdvanceCodeRejection =
  | "REVOKED"
  | "USED"
  | "EXPIRED"
  | "WRONG_ORGANISATION"
  | "BOUND_ELSEWHERE";

const REJECTION_MESSAGES: Record<AdvanceCodeRejection, string> = {
  REVOKED: "That payment code has been withdrawn. Ask the platform team for a new one.",
  USED: "That payment code has already been used.",
  EXPIRED: "That payment code has expired. Ask the platform team for a new one.",
  WRONG_ORGANISATION: "That payment code was issued to a different organisation.",
  BOUND_ELSEWHERE: "That payment code was applied to another payment request.",
};

export interface AdvanceCodeCheck {
  ok: boolean;
  reason?: AdvanceCodeRejection;
  message?: string;
}

/**
 * Whether this code may be used by this organisation on this order right now.
 *
 * The order is optional because checkout has none yet. A code already bound to
 * *this* order is fine -- that is the code that was applied at checkout coming
 * back to confirm -- and a code bound to any other order is not, whatever else
 * is true of it.
 */
export function checkAdvanceCode(
  code: AdvanceCodeSpec,
  ctx: { organizationId: string; orderId: string | null; now: Date },
): AdvanceCodeCheck {
  const refuse = (reason: AdvanceCodeRejection): AdvanceCodeCheck => ({
    ok: false,
    reason,
    message: REJECTION_MESSAGES[reason],
  });
  if (code.revokedAt) return refuse("REVOKED");
  if (code.usedAt) return refuse("USED");
  if (code.organizationId && code.organizationId !== ctx.organizationId) {
    return refuse("WRONG_ORGANISATION");
  }
  if (code.paymentOrderId && code.paymentOrderId !== ctx.orderId) return refuse("BOUND_ELSEWHERE");
  // Checked last, so a used or misdirected code is described as that rather
  // than as merely old.
  if (ctx.now >= code.expiresAt) return refuse("EXPIRED");
  return { ok: true };
}

/** True when using the code would change what is owed. */
export function carriesDiscount(code: Pick<AdvanceCodeSpec, "discountPercent">): boolean {
  return code.discountPercent != null && code.discountPercent > 0;
}

/**
 * What the code takes off the amount it is applied to.
 *
 * Applied to what is *currently* owed -- after any coupon -- rather than to the
 * subtotal, because "twenty per cent off" said on the phone means twenty per
 * cent of the bill the customer is looking at. Capped, and never below zero:
 * a code cannot turn a bill into a refund.
 */
export function advanceDiscount(
  payablePaise: Money,
  code: Pick<AdvanceCodeSpec, "discountPercent" | "maxDiscountPaise">,
): { discountPaise: Money; payablePaise: Money } {
  if (!carriesDiscount(code)) return { discountPaise: 0, payablePaise };
  const raw = pct(payablePaise, code.discountPercent as number);
  const capped = code.maxDiscountPaise != null ? Math.min(raw, code.maxDiscountPaise) : raw;
  const discountPaise = Math.min(Math.max(0, capped), payablePaise);
  return { discountPaise, payablePaise: payablePaise - discountPaise };
}

export type ConfirmationResolution =
  /** The code issued against this very order. The issuer has seen the money. */
  | { kind: "ORDER" }
  /**
   * A code made in advance. `reprice` is true when it carries a discount the
   * order does not yet have -- entered here rather than at checkout -- so the
   * caller has to take it off before the order goes for approval.
   */
  | { kind: "ADVANCE"; code: AdvanceCodeSpec; reprice: boolean }
  /** Neither. `check` says why the advance code, if there was one, was refused. */
  | { kind: "NONE"; check: AdvanceCodeCheck | null };

/**
 * Which kind of code was just typed in, if any.
 *
 * The order-bound code wins outright. It is the stronger claim -- the issuer
 * looked at *this* request and vouched for its payment -- and it is checked
 * with bcrypt against this order alone, so an advance code that happens to
 * share its six digits cannot be mistaken for it anywhere but here, where it
 * would have been accepted anyway.
 */
export function resolveConfirmationCode(input: {
  orderCodeMatches: boolean;
  advance: AdvanceCodeSpec | null;
  organizationId: string;
  orderId: string;
  now: Date;
}): ConfirmationResolution {
  if (input.orderCodeMatches) return { kind: "ORDER" };
  if (!input.advance) return { kind: "NONE", check: null };

  const check = checkAdvanceCode(input.advance, {
    organizationId: input.organizationId,
    orderId: input.orderId,
    now: input.now,
  });
  if (!check.ok) return { kind: "NONE", check };

  // Applied at checkout already: the order was priced with it, so there is
  // nothing to take off twice.
  const appliedHere = input.advance.paymentOrderId === input.orderId;
  return {
    kind: "ADVANCE",
    code: input.advance,
    reprice: carriesDiscount(input.advance) && !appliedHere,
  };
}

/** A six-digit code typed as an offer at checkout is a payment code, not a coupon. */
export function looksLikePaymentCode(value: string | null | undefined): boolean {
  return /^\d{6}$/.test((value ?? "").trim());
}
