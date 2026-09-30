import type { PaymentOrder, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWritable } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { enforce } from "@/lib/ratelimit";
import { verifyCode } from "@/lib/auth/password";
import { decryptOptional, sha256 } from "@/lib/crypto/field";
import { formatMoney } from "@/lib/utils";
import {
  type AdvanceCodeSpec,
  advanceDiscount,
  checkAdvanceCode,
  looksLikePaymentCode,
  resolveConfirmationCode,
} from "@/domain/billing/paymentCodes";
import { settleApproval } from "./approval";
import {
  type CouponSpec,
  buildUpiLink,
  computeOrderAmount,
  validateCoupon,
} from "@/domain/billing/pricing";
import {
  type ConfirmationMode,
  type OrderState,
  availableActions,
  expiresAtFrom,
  isExpired,
  minutesRemaining,
  transition,
} from "@/domain/billing/orderMachine";

/**
 * The organisation's side of buying seats.
 *
 * Every amount is recomputed here from `PlatformSetting`; a total submitted by
 * the browser is never trusted, and the coupon is re-validated at approval time
 * as well as at order time.
 */

export interface PlatformPricing {
  pricePerUserPaise: number;
  currency: string;
  upiId: string;
  payeeName: string;
  windowMinutes: number;
  confirmationMode: ConfirmationMode;
}

export async function getPlatformPricing(): Promise<PlatformPricing> {
  const settings = await prisma.platformSetting.findUnique({ where: { id: "singleton" } });
  return {
    pricePerUserPaise: settings?.pricePerUserPaise ?? 5_900,
    currency: settings?.currency ?? "INR",
    upiId: settings?.paymentUpiId ?? "8434232412@ptyes",
    payeeName: settings?.paymentPayeeName ?? "HRMS Platform",
    windowMinutes: settings?.paymentWindowMinutes ?? 240,
    confirmationMode: (settings?.confirmationMode ?? "BOTH") as ConfirmationMode,
  };
}

async function findCoupon(code: string | null | undefined): Promise<(CouponSpec & { id: string }) | null> {
  if (!code?.trim()) return null;
  const row = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    percent: Number(row.percent),
    maxDiscountPaise: row.maxDiscountPaise,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    maxRedemptions: row.maxRedemptions,
    redemptionCount: row.redemptionCount,
    maxPerOrganisation: row.maxPerOrganisation,
    minUserCount: row.minUserCount,
    maxUserCount: row.maxUserCount,
    firstPurchaseOnly: row.firstPurchaseOnly,
    appliesToOrgId: row.appliesToOrgId,
    active: row.active,
  };
}

/**
 * An advance code, found by its digits.
 *
 * SHA-256 rather than bcrypt because this has to be a lookup: at checkout
 * there is no order yet to compare against, so the code itself is the key.
 * Whether it may be used is `checkAdvanceCode`'s question, not this one's.
 */
async function findAdvanceCode(code: string | null | undefined): Promise<AdvanceCodeSpec | null> {
  const digits = (code ?? "").trim();
  if (!looksLikePaymentCode(digits)) return null;
  const row = await prisma.paymentCode.findFirst({
    where: { codeHash: sha256(digits) },
    // Newest first, so a digit sequence recycled after an old code was spent
    // resolves to the live one.
    orderBy: { issuedAt: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    discountPercent: row.discountPercent == null ? null : Number(row.discountPercent),
    maxDiscountPaise: row.maxDiscountPaise,
    expiresAt: row.expiresAt,
    paymentOrderId: row.paymentOrderId,
    usedAt: row.usedAt,
    revokedAt: row.revokedAt,
  };
}

/**
 * What this buyer's own history says about a coupon.
 *
 * Two counts rather than two booleans, because the limits they answer are
 * numbers: "how many times have *you* used this" and "have you ever bought
 * anything". Both are read fresh at quote time -- a coupon that was usable when
 * the page loaded may not be by the time the order is placed, and the quote is
 * what the order is built from.
 */
async function couponHistory(
  organizationId: string,
  couponId: string,
): Promise<{ organizationRedemptions: number; hasPurchasedBefore: boolean }> {
  const [organizationRedemptions, approved] = await Promise.all([
    prisma.couponRedemption.count({ where: { organizationId, couponId } }),
    // APPROVED and nothing else. An order that was raised and abandoned is not
    // a purchase, and counting it would refuse a first-time buyer their
    // first-purchase discount for having once opened the page.
    prisma.paymentOrder.count({ where: { organizationId, status: "APPROVED" } }),
  ]);
  return { organizationRedemptions, hasPurchasedBefore: approved > 0 };
}

export interface Quote {
  userCount: number;
  periodMonths: number;
  pricePerUserPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  payablePaise: number;
  coupon: { code: string; percent: number } | null;
  /**
   * A Broadmate payment code typed into the same box.
   *
   * Six digits where a coupon is letters. It is not a coupon -- it will also
   * confirm the payment later -- but at checkout it behaves like one: its
   * discount, if it has one, is priced in from the start so the QR is right.
   */
  paymentCode: { percent: number | null; discountPaise: number } | null;
  couponError: string | null;
  currency: string;
}

/** Live quote for the seat selector. No writes, so it can run on every keystroke. */
export async function quoteOrder(
  ctx: AuthContext,
  input: { userCount: number; periodMonths?: number; couponCode?: string | null },
): Promise<Quote> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");

  const pricing = await getPlatformPricing();
  const periodMonths = input.periodMonths ?? 12;
  const coupon = await findCoupon(input.couponCode);

  let couponError: string | null = null;
  let applied: CouponSpec | null = null;

  if (input.couponCode?.trim()) {
    const history = coupon
      ? await couponHistory(ctx.organizationId, coupon.id)
      : { organizationRedemptions: 0, hasPurchasedBefore: false };
    const check = validateCoupon(coupon, {
      userCount: input.userCount,
      organizationId: ctx.organizationId,
      now: new Date(),
      ...history,
    });
    if (check.ok && coupon) applied = coupon;
    else couponError = check.message ?? "That coupon cannot be used.";
  }

  /**
   * Six digits and no coupon by that name: try it as a payment code.
   *
   * The coupon is looked up first so that a coupon somebody named with digits
   * keeps working; only when nothing answers to those digits is the advance
   * table asked. A code that exists but may not be used here says why, in
   * the same red line a bad coupon uses.
   */
  let paymentCode: AdvanceCodeSpec | null = null;
  if (!coupon && looksLikePaymentCode(input.couponCode)) {
    const found = await findAdvanceCode(input.couponCode);
    const check = found
      ? checkAdvanceCode(found, { organizationId: ctx.organizationId, orderId: null, now: new Date() })
      : { ok: false, message: "That code does not exist. Check the digits, or ask the platform team." };
    if (found && check.ok) {
      paymentCode = found;
      couponError = null;
    } else {
      couponError = check.message ?? "That payment code cannot be used.";
    }
  }

  const amount = computeOrderAmount({
    userCount: input.userCount,
    pricePerUserPaise: pricing.pricePerUserPaise,
    periods: periodMonths,
    coupon: applied,
  });
  // Off what is owed after the coupon, which is what "twenty per cent off"
  // means when it is said on the phone about the bill on screen.
  const extra = paymentCode
    ? advanceDiscount(amount.payablePaise, paymentCode)
    : { discountPaise: 0, payablePaise: amount.payablePaise };

  return {
    userCount: amount.userCount,
    periodMonths,
    pricePerUserPaise: amount.pricePerUserPaise,
    subtotalPaise: amount.subtotalPaise,
    discountPaise: amount.discountPaise + extra.discountPaise,
    payablePaise: extra.payablePaise,
    coupon: applied ? { code: applied.code, percent: applied.percent } : null,
    paymentCode: paymentCode
      ? { percent: paymentCode.discountPercent, discountPaise: extra.discountPaise }
      : null,
    couponError,
    currency: pricing.currency,
  };
}

export interface CheckoutCoupon {
  code: string;
  description: string | null;
  percent: number;
  maxDiscountPaise: number | null;
  expiresAt: Date;
  /** Whether it can be applied to the order as it stands right now. */
  applies: boolean;
  /** Why not, in the buyer's words. Null when it applies. */
  reason: string | null;
}

/**
 * The offers this organisation can see at checkout.
 *
 * Only coupons somebody deliberately published -- `listed` is false by default,
 * so a code emailed to one customer never turns up in a dropdown for everybody
 * else. A coupon tied to one organisation is shown only to that organisation,
 * which is the same rule the validator applies and has to be applied here too:
 * a list that named it would leak both the offer and the fact that somebody
 * else has a private deal.
 *
 * Coupons that do not fit the current order are returned rather than hidden,
 * with the reason attached. "Not for this many users" is worth reading: it is
 * the difference between a buyer thinking the product has no offers and a buyer
 * discovering that thirty more seats would pay for themselves.
 */
export async function listCheckoutCoupons(
  ctx: AuthContext,
  input: { userCount: number },
): Promise<CheckoutCoupon[]> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");

  const now = new Date();
  const rows = await prisma.coupon.findMany({
    where: {
      listed: true,
      active: true,
      startsAt: { lte: now },
      expiresAt: { gte: now },
      OR: [{ appliesToOrgId: null }, { appliesToOrgId: ctx.organizationId }],
    },
    orderBy: [{ percent: "desc" }, { expiresAt: "asc" }],
    take: 50,
  });
  if (rows.length === 0) return [];

  const [redemptions, approved] = await Promise.all([
    prisma.couponRedemption.groupBy({
      by: ["couponId"],
      where: { organizationId: ctx.organizationId, couponId: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    }),
    prisma.paymentOrder.count({
      where: { organizationId: ctx.organizationId, status: "APPROVED" },
    }),
  ]);
  const usedByCoupon = new Map(redemptions.map((r) => [r.couponId, r._count._all]));

  return rows.map((row) => {
    const check = validateCoupon(
      {
        code: row.code,
        percent: Number(row.percent),
        maxDiscountPaise: row.maxDiscountPaise,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        maxRedemptions: row.maxRedemptions,
        redemptionCount: row.redemptionCount,
        maxPerOrganisation: row.maxPerOrganisation,
        minUserCount: row.minUserCount,
        maxUserCount: row.maxUserCount,
        firstPurchaseOnly: row.firstPurchaseOnly,
        appliesToOrgId: row.appliesToOrgId,
        active: row.active,
      },
      {
        userCount: input.userCount,
        organizationId: ctx.organizationId,
        now,
        organizationRedemptions: usedByCoupon.get(row.id) ?? 0,
        hasPurchasedBefore: approved > 0,
      },
    );

    return {
      code: row.code,
      description: row.description,
      percent: Number(row.percent),
      maxDiscountPaise: row.maxDiscountPaise,
      expiresAt: row.expiresAt,
      applies: check.ok,
      reason: check.ok ? null : (check.message ?? "Not available for this order."),
    };
  });
}

export async function createOrder(
  ctx: AuthContext,
  input: { userCount: number; periodMonths?: number; couponCode?: string | null },
): Promise<PaymentOrder> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");
  // Deliberately not requireWritable: an organisation whose subscription has
  // lapsed must still be able to buy its way back in.

  if (!Number.isInteger(input.userCount) || input.userCount < 1) {
    throw new ValidationError("Choose how many users you need.");
  }
  if (input.userCount > 10_000) {
    throw new ValidationError("For more than 10,000 users, please contact us directly.");
  }

  await enforce("paymentCode", `order:${ctx.organizationId}`, { limit: 10, windowSeconds: 3_600 });

  const pricing = await getPlatformPricing();
  const quote = await quoteOrder(ctx, input);
  if (quote.couponError && input.couponCode?.trim()) {
    throw new ValidationError(quote.couponError);
  }

  const coupon = await findCoupon(input.couponCode);
  // Looked up again rather than carried on the quote, so the id that gets
  // bound is the row that was checked a moment ago and not a string from the
  // browser.
  const paymentCode = quote.paymentCode ? await findAdvanceCode(input.couponCode) : null;
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: ctx.organizationId },
    select: { seats: true },
  });

  const now = new Date();

  /**
   * Retried, because a serial read then written is a race by construction.
   *
   * Reading the highest number and inserting the next one is two steps, and two
   * buyers pressing the button in the same second both read the same highest.
   * One of them wins and the other gets a unique violation -- which, before
   * this, reached them as "something went wrong on our side" and lost the
   * order. Re-reading and trying again is the whole fix; four attempts is far
   * past what the real rate of purchases needs.
   */
  const order = await createWithOrderNumber((orderNumber) =>
    prisma.$transaction(async (tx) => {
      const created = await tx.paymentOrder.create({
        data: {
          organizationId: ctx.organizationId,
          orderNumber,
          userCount: quote.userCount,
          pricePerUserPaise: quote.pricePerUserPaise,
          subtotalPaise: quote.subtotalPaise,
          discountPaise: quote.discountPaise,
          payablePaise: quote.payablePaise,
          couponId: quote.coupon ? coupon?.id : null,
          couponCode: quote.coupon?.code ?? null,
          status: "INITIATED",
          upiId: pricing.upiId,
          periodMonths: quote.periodMonths,
          // The window is frozen onto the row, so changing the platform setting
          // later cannot extend or shorten an order already in flight.
          expiresAt: expiresAtFrom(now, pricing.windowMinutes),
          windowMinutes: pricing.windowMinutes,
          previousSeats: subscription?.seats ?? 0,
          createdById: ctx.userId,
        },
      });

      /**
       * The code is bound to the order in the same transaction that prices
       * the order with it, and only if it is still free. Two checkouts racing
       * the same code both pass the quote; the `paymentOrderId: null` here is
       * what makes only one of them win, and the loser's order is rolled back
       * rather than left priced with a discount it does not hold.
       */
      if (paymentCode) {
        const bound = await tx.paymentCode.updateMany({
          where: { id: paymentCode.id, usedAt: null, revokedAt: null, paymentOrderId: null },
          data: { paymentOrderId: created.id, appliedAt: now },
        });
        if (bound.count === 0) {
          throw new ConflictError("That payment code was just used on another request.");
        }
      }
      return created;
    }),
  );

  await prisma.paymentOrderEvent.create({
    data: { paymentOrderId: order.id, toStatus: "INITIATED", actorId: ctx.userId },
  });

  await writeAudit(ctx, {
    action: "payment.order_created",
    entityType: "PaymentOrder",
    entityId: order.id,
    after: {
      orderNumber: order.orderNumber,
      userCount: order.userCount,
      payablePaise: order.payablePaise,
      couponCode: order.couponCode,
      paymentCodeId: paymentCode?.id ?? null,
    },
  });

  return order;
}

function toState(order: PaymentOrder): OrderState {
  return {
    status: order.status,
    expiresAt: order.expiresAt,
    issuedCodeHash: order.issuedCodeHash,
    codeAttemptCount: order.codeAttemptCount,
    confirmationCode: order.confirmationCode,
    transactionRef: order.transactionRef,
  };
}

/** Marks an order expired the moment anybody looks at it past its window. */
async function settleExpiry(order: PaymentOrder): Promise<PaymentOrder> {
  if (!isExpired(toState(order), new Date())) return order;
  if (order.status === "EXPIRED") return order;

  const updated = await prisma.paymentOrder.update({
    where: { id: order.id },
    data: { status: "EXPIRED" },
  });
  await prisma.paymentOrderEvent.create({
    data: {
      paymentOrderId: order.id,
      fromStatus: order.status,
      toStatus: "EXPIRED",
      note: "Confirmation window elapsed",
    },
  });
  return updated;
}

export interface OrderView {
  order: PaymentOrder;
  minutesRemaining: number;
  expired: boolean;
  actions: string[];
  upiLink: string;
  confirmationMode: ConfirmationMode;
  /**
   * The advance code on this order, if any: applied at checkout and still
   * waiting to confirm (`used: false`, and the confirm screen offers one button
   * for it instead of asking for the digits again), or already spent on it.
   */
  paymentCode: { percent: number | null; used: boolean } | null;
}

export async function getOrderForOrg(ctx: AuthContext, orderId: string): Promise<OrderView> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");

  const found = await prisma.paymentOrder.findFirst({
    where: { id: orderId, organizationId: ctx.organizationId },
  });
  if (!found) throw new NotFoundError("That payment request");

  const order = await settleExpiry(found);
  const pricing = await getPlatformPricing();
  const now = new Date();
  const bound = await prisma.paymentCode.findUnique({
    where: { paymentOrderId: order.id },
    select: { discountPercent: true, usedAt: true, revokedAt: true },
  });

  return {
    order,
    paymentCode:
      bound && !bound.revokedAt
        ? {
            percent: bound.discountPercent == null ? null : Number(bound.discountPercent),
            used: bound.usedAt != null,
          }
        : null,
    minutesRemaining: minutesRemaining(toState(order), now),
    expired: order.status === "EXPIRED",
    actions: availableActions(toState(order), { now, mode: pricing.confirmationMode }, "ORG"),
    upiLink: buildUpiLink({
      upiId: order.upiId,
      payeeName: pricing.payeeName,
      amountPaise: order.payablePaise,
      note: `HRMS ${order.userCount} seats ${order.orderNumber}`,
      transactionRef: order.orderNumber,
    }),
    confirmationMode: pricing.confirmationMode,
  };
}

export async function listOrdersForOrg(ctx: AuthContext): Promise<PaymentOrder[]> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");

  const orders = await prisma.paymentOrder.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  // Expiry is evaluated on read as well as on write, so a stale row can never
  // be presented as still actionable.
  return Promise.all(orders.map(settleExpiry));
}

/** "I have paid" — the organisation supplies a UTR / reference. */
export async function submitReference(
  ctx: AuthContext,
  orderId: string,
  input: { reference: string; note?: string },
): Promise<PaymentOrder> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");

  const found = await prisma.paymentOrder.findFirst({
    where: { id: orderId, organizationId: ctx.organizationId },
  });
  if (!found) throw new NotFoundError("That payment request");

  const order = await settleExpiry(found);
  const pricing = await getPlatformPricing();
  const now = new Date();

  const result = transition(
    toState(order),
    { type: "SUBMIT_REFERENCE", reference: input.reference, note: input.note },
    { now, mode: pricing.confirmationMode },
  );
  if (!result.ok || !result.next) throw new ConflictError(result.message ?? "That is not possible now.");

  const updated = await prisma.paymentOrder.update({
    where: { id: order.id },
    data: {
      status: result.next.status,
      transactionRef: result.next.transactionRef,
      confirmationCode: result.next.confirmationCode,
      payerNote: input.note ?? null,
      submittedAt: now,
    },
  });

  await prisma.paymentOrderEvent.create({
    data: {
      paymentOrderId: order.id,
      fromStatus: order.status,
      toStatus: updated.status,
      note: input.note ?? null,
      actorId: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payment.submitted",
    entityType: "PaymentOrder",
    entityId: order.id,
    after: { transactionRef: updated.transactionRef },
  });

  await notify.toSuperadmins({
    type: "payment.submitted",
    title: "Payment confirmation submitted",
    body: `${ctx.organization?.name ?? "An organisation"} submitted ${updated.orderNumber} for review.`,
    link: "/platform/payments",
  });

  return updated;
}

/**
 * "There is nothing to pay" -- the confirmation for a bill of zero.
 *
 * A coupon can cover the whole amount, and until now the order then sat on a
 * screen asking for the UPI reference of a payment nobody could make. The
 * organisation was stuck: nothing to quote, no code issued, and a four-hour
 * window counting down on an amount of nothing.
 *
 * **The guard is the whole function.** The button that calls this appears only
 * when the payable is zero, but a button is not an authorisation -- the check
 * is here, against the order row, or this would be a way to submit any order
 * without paying it. Everything after that is the reference path with no
 * reference: same state, same review queue, same approval, so the platform
 * owner still sees every zero-rated order before seats are granted.
 */
export async function submitNothingToPay(ctx: AuthContext, orderId: string): Promise<PaymentOrder> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");

  const found = await prisma.paymentOrder.findFirst({
    where: { id: orderId, organizationId: ctx.organizationId },
  });
  if (!found) throw new NotFoundError("That payment request");

  const order = await settleExpiry(found);
  if (order.payablePaise !== 0) {
    throw new ValidationError(
      `There is ${formatMoney(order.payablePaise)} to pay on this request. Confirm it with your payment reference.`,
    );
  }

  const pricing = await getPlatformPricing();
  const now = new Date();
  const result = transition(
    toState(order),
    { type: "SUBMIT_NOTHING_DUE" },
    { now, mode: pricing.confirmationMode },
  );
  if (!result.ok || !result.next) throw new ConflictError(result.message ?? "That is not possible now.");

  const updated = await prisma.paymentOrder.update({
    where: { id: order.id },
    data: {
      status: result.next.status,
      transactionRef: null,
      confirmationCode: null,
      // Written where a reviewer looks, so the empty reference reads as a
      // fact and not as something the organisation forgot.
      payerNote: "Nothing to pay: the coupon covered the full amount.",
      submittedAt: now,
    },
  });

  await prisma.paymentOrderEvent.create({
    data: {
      paymentOrderId: order.id,
      fromStatus: order.status,
      toStatus: updated.status,
      note: "Confirmed with nothing to pay",
      actorId: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payment.submitted",
    entityType: "PaymentOrder",
    entityId: order.id,
    after: { nothingToPay: true, couponCode: order.couponCode },
  });

  await notify.toSuperadmins({
    type: "payment.submitted",
    title: "Zero-rated order submitted",
    body: `${ctx.organization?.name ?? "An organisation"} confirmed ${updated.orderNumber} with nothing to pay (${order.couponCode ?? "no coupon"}).`,
    link: "/platform/payments",
  });

  return updated;
}

/** Mode CODE: the organisation enters the code the Superadmin gave them. */
export async function submitConfirmationCode(
  ctx: AuthContext,
  orderId: string,
  code: string,
): Promise<PaymentOrder> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");
  await enforce("paymentCode", `verify:${ctx.organizationId}:${orderId}`);
  // Keyed on the organisation as well as the order, because a new order is a
  // new key, and an advance code can be guessed against any order.
  await enforce("paymentCode", `advance:${ctx.organizationId}`, { limit: 10, windowSeconds: 900 });

  const found = await prisma.paymentOrder.findFirst({
    where: { id: orderId, organizationId: ctx.organizationId },
  });
  if (!found) throw new NotFoundError("That payment request");

  const order = await settleExpiry(found);
  const pricing = await getPlatformPricing();
  const now = new Date();

  /**
   * Two kinds of code can be typed into the one box.
   *
   * The order's own issued code is compared with bcrypt against this order;
   * an advance code is looked up by its digits and checked against this
   * organisation. `resolveConfirmationCode` decides which was typed, and the
   * order-bound one wins because the owner looked at *this* request when
   * they issued it. What each one does next is different enough that they do
   * not share a path below.
   */
  const state = toState(order);
  const orderCodeMatches = state.issuedCodeHash ? await verifyCode(code, state.issuedCodeHash) : false;
  const resolved = resolveConfirmationCode({
    orderCodeMatches,
    advance: orderCodeMatches ? null : await findAdvanceCode(code),
    organizationId: ctx.organizationId,
    orderId: order.id,
    now,
  });

  if (resolved.kind === "ADVANCE") return confirmWithAdvanceCode(ctx, order, code, resolved, now, pricing.confirmationMode);

  // The machine decides *whether* the code may be checked; bcrypt decided
  // whether it matches. Verification is injected so hashing stays out of the
  // domain. A wrong advance code counts as an attempt against the order too,
  // so guessing is bounded the same way from either direction.
  const result = transition(
    state,
    { type: "SUBMIT_CODE", code },
    { now, mode: pricing.confirmationMode, verifyCode: () => resolved.kind === "ORDER" },
  );

  if (!result.ok) {
    if (result.next) {
      await prisma.paymentOrder.update({
        where: { id: order.id },
        data: { codeAttemptCount: result.next.codeAttemptCount },
      });
    }
    const why = resolved.kind === "NONE" ? resolved.check?.message : null;
    throw new ConflictError(why ?? result.message ?? "That confirmation code is not correct.");
  }

  const updated = await prisma.paymentOrder.update({
    where: { id: order.id },
    data: {
      status: result.next!.status,
      confirmationCode: result.next!.confirmationCode,
      submittedAt: now,
    },
  });

  await prisma.paymentOrderEvent.create({
    data: {
      paymentOrderId: order.id,
      fromStatus: order.status,
      toStatus: updated.status,
      note: "Confirmation code accepted",
      actorId: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payment.submitted",
    entityType: "PaymentOrder",
    entityId: order.id,
    metadata: { via: "issued_code" },
  });

  /**
   * Issued against this order, so approved by it.
   *
   * The owner looked at this request, saw the money, and handed over six
   * digits that mean "yes"; the organisation typing them in is the handshake
   * completing. Making the owner come back to press Approve as well was one
   * more thing for a paying customer to wait on. Recorded as the issuer's
   * approval, because it is theirs -- the audit row names who typed the code.
   */
  if (order.codeIssuedById) {
    return settleApproval(ctx, updated, {
      actorUserId: order.codeIssuedById,
      mode: pricing.confirmationMode,
      note: "Approved by the code issued for this request",
      via: "issued_code",
    });
  }

  await notify.toSuperadmins({
    type: "payment.submitted",
    title: "Confirmation code accepted",
    body: `${ctx.organization?.name ?? "An organisation"} confirmed ${updated.orderNumber}. Ready for approval.`,
    link: "/platform/payments",
  });

  return updated;
}

/**
 * An advance code, typed at confirmation.
 *
 * If it was applied at checkout the order is already priced with it and this
 * only spends it. If it carries a discount and was not, the order is re-priced
 * here -- the customer was told the number on the phone and has paid it, and
 * the QR they saw earlier said something else. The approver sees old and new
 * on the event, and approval is still theirs: the money was not seen when the
 * code was made.
 */
async function confirmWithAdvanceCode(
  ctx: AuthContext,
  order: PaymentOrder,
  code: string,
  resolved: { code: AdvanceCodeSpec; reprice: boolean },
  now: Date,
  mode: ConfirmationMode,
): Promise<PaymentOrder> {
  const result = transition(toState(order), { type: "SUBMIT_ADVANCE_CODE", code }, { now, mode });
  if (!result.ok || !result.next) throw new ConflictError(result.message ?? "That is not possible now.");

  const repriced = resolved.reprice
    ? advanceDiscount(order.payablePaise, resolved.code)
    : { discountPaise: 0, payablePaise: order.payablePaise };

  const updated = await prisma.$transaction(async (tx) => {
    // Spent first, in its own write, so two requests racing the same code
    // cannot both confirm with it.
    const spent = await tx.paymentCode.updateMany({
      where: {
        id: resolved.code.id,
        usedAt: null,
        revokedAt: null,
        OR: [{ paymentOrderId: null }, { paymentOrderId: order.id }],
      },
      data: { usedAt: now, paymentOrderId: order.id },
    });
    if (spent.count === 0) throw new ConflictError("That payment code has already been used.");

    const saved = await tx.paymentOrder.update({
      where: { id: order.id },
      data: {
        status: result.next!.status,
        confirmationCode: result.next!.confirmationCode,
        submittedAt: now,
        ...(resolved.reprice
          ? {
              discountPaise: order.discountPaise + repriced.discountPaise,
              payablePaise: repriced.payablePaise,
            }
          : {}),
      },
    });

    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: order.id,
        fromStatus: order.status,
        toStatus: saved.status,
        note: resolved.reprice
          ? `Payment code accepted; re-priced from ${formatMoney(order.payablePaise)} to ${formatMoney(repriced.payablePaise)}`
          : "Payment code accepted",
        actorId: ctx.userId,
      },
    });

    return saved;
  });

  await writeAudit(ctx, {
    action: "payment.submitted",
    entityType: "PaymentOrder",
    entityId: order.id,
    before: { payablePaise: order.payablePaise, discountPaise: order.discountPaise },
    after: { payablePaise: updated.payablePaise, discountPaise: updated.discountPaise },
    metadata: { via: "advance_code", paymentCodeId: resolved.code.id, repriced: resolved.reprice },
  });

  await notify.toSuperadmins({
    type: "payment.submitted",
    title: "Payment code accepted",
    body: `${ctx.organization?.name ?? "An organisation"} confirmed ${updated.orderNumber} with a payment code${
      resolved.reprice ? ` (re-priced to ${formatMoney(updated.payablePaise)})` : ""
    }. Ready for approval.`,
    link: "/platform/payments",
  });

  return updated;
}

/**
 * "I have paid" for an order whose code was applied at checkout.
 *
 * The digits are already bound to the order, so the organisation is not asked
 * to type them again; the button is the confirmation. Everything else is the
 * advance-code path.
 */
export async function submitBoundCode(ctx: AuthContext, orderId: string): Promise<PaymentOrder> {
  requireOrg(ctx);
  requirePermission(ctx, "org.billing.manage");

  const found = await prisma.paymentOrder.findFirst({
    where: { id: orderId, organizationId: ctx.organizationId },
  });
  if (!found) throw new NotFoundError("That payment request");
  const order = await settleExpiry(found);

  const bound = await prisma.paymentCode.findUnique({ where: { paymentOrderId: order.id } });
  if (!bound || bound.usedAt || bound.revokedAt) {
    throw new ConflictError("No payment code is waiting on this request. Enter a reference or a code instead.");
  }

  const pricing = await getPlatformPricing();
  const spec: AdvanceCodeSpec = {
    id: bound.id,
    organizationId: bound.organizationId,
    discountPercent: bound.discountPercent == null ? null : Number(bound.discountPercent),
    maxDiscountPaise: bound.maxDiscountPaise,
    expiresAt: bound.expiresAt,
    paymentOrderId: bound.paymentOrderId,
    usedAt: bound.usedAt,
    revokedAt: bound.revokedAt,
  };
  const now = new Date();
  const check = checkAdvanceCode(spec, { organizationId: ctx.organizationId, orderId: order.id, now });
  if (!check.ok) throw new ConflictError(check.message ?? "That payment code cannot be used now.");

  // The digits are kept on the order as the confirmation, the same as if they
  // had been typed: the owner's queue shows what confirmed it.
  const digits = decryptOptional(bound.codeCipher) ?? "";
  return confirmWithAdvanceCode(ctx, order, digits, { code: spec, reprice: false }, now, pricing.confirmationMode);
}

/**
 * The next order number, from the highest one in use.
 *
 * **It counted rows and added one, and that broke payment outright.** There are
 * ten orders on the live instance, numbered 0005 to 0014 -- the first four were
 * deleted at some point -- so the count was 10 and the next number it offered
 * was 0011, which already existed. Every attempt to buy seats failed on the
 * unique constraint, for every organisation, with or without a coupon, and it
 * would have gone on failing for ever: a count never catches up with a series
 * that has a gap in it.
 *
 * A serial has to come from the series, not from how many rows happen to be
 * sitting in the table. `MAX` of the numeric tail is the same shape
 * `nextEmployeeCode` has used since it was written, and for the same reason.
 *
 * Cast rather than sorted: the numbers are inside text, so `ORD-2026-1000`
 * sorts below `ORD-2026-0999` and an `ORDER BY` hands back the wrong row.
 */
export async function nextOrderNumber(tx?: Prisma.TransactionClient): Promise<string> {
  const db = tx ?? prisma;
  const year = new Date().getFullYear();

  /**
   * The mark is the platform's, not the buyer's.
   *
   * An organisation's prefix answers "whose employee is this"; an invoice
   * number answers "who issued this", and the issuer is always the platform.
   * `ORD` said neither.
   */
  const settings = await db.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { invoicePrefix: true },
  });
  const mark = (settings?.invoicePrefix ?? "BMG").toUpperCase();

  /**
   * The series continues across a change of prefix.
   *
   * Matching only the current mark would restart at 0001 beside an existing
   * ORD-2026-0014, and two invoices numbered 0001 in one year is worse than a
   * prefix that changes mid-series. The year is what bounds the series; the
   * mark is only what it is called.
   */
  const [row] = await db.$queryRaw<{ highest: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("orderNumber" FROM '[0-9]+$') AS INTEGER)) AS highest
    FROM "PaymentOrder"
    WHERE "orderNumber" LIKE ${`%-${year}-%`}
  `;

  return `${mark}-${year}-${String((row?.highest ?? 0) + 1).padStart(4, "0")}`;
}

/**
 * Insert a row whose order number may already have been taken.
 *
 * The caller is handed a number and gives back the promise of the insert. If
 * that insert loses a race, the number is derived again from whatever the
 * winner just wrote and the insert is retried. The last attempt is allowed to
 * throw, because at that point something other than a race is wrong and hiding
 * it would be worse than the error.
 */
async function createWithOrderNumber<T>(
  insert: (orderNumber: string) => Promise<T>,
  attempts = 4,
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await insert(await nextOrderNumber());
    } catch (error) {
      if (attempt === attempts || !isUniqueViolation(error)) throw error;
    }
  }
  // Unreachable: the loop either returns or throws on its last pass.
  throw new Error("Could not allocate an order number.");
}

/** Whether a thrown error is Prisma's "that unique value is taken". */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
