import { describe, expect, it } from "vitest";
import {
  type CouponSpec,
  PricingError,
  buildUpiLink,
  computeMrr,
  computeOrderAmount,
  validateCoupon,
} from "./pricing";
import {
  type OrderState,
  availableActions,
  expiresAtFrom,
  isExpired,
  minutesRemaining,
  transition,
} from "./orderMachine";
import { canActivateEmployee, isBillable, resolveAccessState, isReadOnly } from "./seats";

const PRICE = 5_900; // ₹59 in paise, as seeded into PlatformSetting
const NOW = new Date("2026-04-10T10:00:00.000Z");

function coupon(overrides: Partial<CouponSpec> = {}): CouponSpec {
  return {
    code: "SAVE10",
    percent: 10,
    startsAt: new Date("2026-04-01T00:00:00.000Z"),
    expiresAt: new Date("2026-04-30T23:59:59.000Z"),
    redemptionCount: 0,
    active: true,
    ...overrides,
  };
}

// ------------------------------------------------------------------ pricing

describe("pricing", () => {
  it("charges ₹59 per user per period", () => {
    expect(computeOrderAmount({ userCount: 10, pricePerUserPaise: PRICE }).payablePaise).toBe(59_000);
    expect(computeOrderAmount({ userCount: 50, pricePerUserPaise: PRICE }).payablePaise).toBe(295_000);
    expect(computeOrderAmount({ userCount: 100, pricePerUserPaise: PRICE }).payablePaise).toBe(590_000);
  });

  it("multiplies by the number of billing periods", () => {
    const q = computeOrderAmount({ userCount: 10, pricePerUserPaise: PRICE, periods: 12 });
    expect(q.subtotalPaise).toBe(708_000);
  });

  it("applies a percentage discount", () => {
    const q = computeOrderAmount({ userCount: 10, pricePerUserPaise: PRICE, coupon: coupon() });
    expect(q.subtotalPaise).toBe(59_000);
    expect(q.discountPaise).toBe(5_900);
    expect(q.payablePaise).toBe(53_100);
    expect(q.couponCode).toBe("SAVE10");
  });

  it("honours a maximum discount cap", () => {
    const q = computeOrderAmount({
      userCount: 100,
      pricePerUserPaise: PRICE,
      coupon: coupon({ percent: 50, maxDiscountPaise: 100_000 }),
    });
    expect(q.discountPaise).toBe(100_000);
    expect(q.payablePaise).toBe(490_000);
  });

  it("never turns a discount into a refund", () => {
    const q = computeOrderAmount({
      userCount: 10,
      pricePerUserPaise: PRICE,
      coupon: coupon({ percent: 150 }),
    });
    expect(q.discountPaise).toBe(59_000);
    expect(q.payablePaise).toBe(0);
  });

  it("rejects nonsensical seat counts", () => {
    expect(() => computeOrderAmount({ userCount: 0, pricePerUserPaise: PRICE })).toThrow(PricingError);
    expect(() => computeOrderAmount({ userCount: 1.5, pricePerUserPaise: PRICE })).toThrow(PricingError);
  });

  it("builds a UPI link carrying the server-computed amount", () => {
    const link = buildUpiLink({
      upiId: "8434232412@ptyes",
      payeeName: "HRMS Platform",
      amountPaise: 53_100,
      note: "HRMS 10 seats",
    });
    expect(link).toContain("pa=8434232412%40ptyes");
    expect(link).toContain("am=531.00");
    expect(link).toContain("cu=INR");
  });

  it("computes MRR from paying subscriptions only", () => {
    const mrr = computeMrr([
      { seats: 10, pricePerUserPaise: PRICE, billingMode: "PAID" },
      { seats: 50, pricePerUserPaise: PRICE, billingMode: "PAID" },
      { seats: 20, pricePerUserPaise: PRICE, billingMode: "TRIAL" },
      { seats: 99, pricePerUserPaise: PRICE, billingMode: "FREE_INTERNAL" },
    ]);
    expect(mrr).toBe(354_000);
  });
});

// ------------------------------------------------------------------ coupons

describe("coupon validation", () => {
  const ctx = { userCount: 10, organizationId: "org_1", now: NOW };

  it("accepts a valid coupon", () => {
    expect(validateCoupon(coupon(), ctx).ok).toBe(true);
  });

  it("rejects an unknown code", () => {
    expect(validateCoupon(null, ctx).reason).toBe("NOT_FOUND");
  });

  it("rejects an inactive coupon", () => {
    expect(validateCoupon(coupon({ active: false }), ctx).reason).toBe("INACTIVE");
  });

  it("rejects a coupon that has not started", () => {
    expect(validateCoupon(coupon({ startsAt: new Date("2026-05-01") }), ctx).reason).toBe("NOT_STARTED");
  });

  it("rejects an expired coupon", () => {
    expect(validateCoupon(coupon({ expiresAt: new Date("2026-04-01") }), ctx).reason).toBe("EXPIRED");
  });

  it("rejects a coupon that has hit its redemption limit", () => {
    expect(validateCoupon(coupon({ maxRedemptions: 5, redemptionCount: 5 }), ctx).reason).toBe("EXHAUSTED");
  });

  it("enforces the seat range", () => {
    expect(validateCoupon(coupon({ minUserCount: 20 }), ctx).reason).toBe("USER_COUNT_TOO_LOW");
    expect(validateCoupon(coupon({ maxUserCount: 5 }), ctx).reason).toBe("USER_COUNT_TOO_HIGH");
  });

  it("keeps an org-specific coupon to that org", () => {
    expect(validateCoupon(coupon({ appliesToOrgId: "org_2" }), ctx).reason).toBe("WRONG_ORGANISATION");
    expect(validateCoupon(coupon({ appliesToOrgId: "org_1" }), ctx).ok).toBe(true);
  });

  /**
   * Two limits about the buyer rather than about the offer.
   *
   * `maxRedemptions` counts every organisation together, so one buyer could
   * spend a hundred-use launch coupon entirely on its own renewals and nobody
   * else would ever see the offer. And an offer meant to bring somebody in
   * should not keep paying out afterwards.
   */
  it("limits how many times one organisation may use it", () => {
    const twice = coupon({ maxPerOrganisation: 2 });
    expect(validateCoupon(twice, { ...ctx, organizationRedemptions: 1 }).ok).toBe(true);
    expect(validateCoupon(twice, { ...ctx, organizationRedemptions: 2 }).reason).toBe("ALREADY_USED");
  });

  it("counts that separately from the total across everybody", () => {
    // Ninety-eight uses left overall, and none left for this buyer.
    const busy = coupon({ maxRedemptions: 100, redemptionCount: 2, maxPerOrganisation: 1 });
    expect(validateCoupon(busy, { ...ctx, organizationRedemptions: 1 }).reason).toBe("ALREADY_USED");
  });

  it("holds a first-purchase coupon to a first purchase", () => {
    const welcome = coupon({ firstPurchaseOnly: true });
    expect(validateCoupon(welcome, { ...ctx, hasPurchasedBefore: false }).ok).toBe(true);
    expect(validateCoupon(welcome, { ...ctx, hasPurchasedBefore: true }).reason).toBe(
      "NOT_FIRST_PURCHASE",
    );
  });

  it("and both are silent on a coupon that does not set them", () => {
    // The permissive default matters more than it looks. This function runs at
    // quote time, at order time and again at approval; a caller that has not
    // been taught to pass the history must behave exactly as it did before
    // these existed, rather than quietly starting to refuse people.
    expect(validateCoupon(coupon(), { ...ctx, hasPurchasedBefore: true }).ok).toBe(true);
    expect(validateCoupon(coupon(), { ...ctx, organizationRedemptions: 99 }).ok).toBe(true);
    expect(validateCoupon(coupon({ maxPerOrganisation: 1 }), ctx).ok).toBe(true);
    expect(validateCoupon(coupon({ firstPurchaseOnly: true }), ctx).ok).toBe(true);
  });
});

// ------------------------------------------------------------------ order machine

describe("payment order state machine", () => {
  function order(overrides: Partial<OrderState> = {}): OrderState {
    return {
      status: "INITIATED",
      expiresAt: expiresAtFrom(NOW, 240),
      issuedCodeHash: null,
      codeAttemptCount: 0,
      confirmationCode: null,
      transactionRef: null,
      ...overrides,
    };
  }
  const utrCtx = { now: NOW, mode: "UTR" as const };
  const codeCtx = {
    now: NOW,
    mode: "CODE" as const,
    verifyCode: (plain: string, hash: string) => hash === `hashed:${plain}`,
  };

  it("gives a 4-hour confirmation window by default", () => {
    const state = order();
    expect(minutesRemaining(state, NOW)).toBe(240);
    expect(isExpired(state, NOW)).toBe(false);
  });

  it("runs the UTR flow to approval", () => {
    const submitted = transition(order(), { type: "SUBMIT_REFERENCE", reference: "UTR12345" }, utrCtx);
    expect(submitted.ok).toBe(true);
    expect(submitted.next?.status).toBe("AWAITING_CONFIRMATION");
    expect(submitted.next?.transactionRef).toBe("UTR12345");

    const approved = transition(submitted.next!, { type: "APPROVE", actorId: "super_1" }, utrCtx);
    expect(approved.next?.status).toBe("APPROVED");
  });

  it("runs the issued-code flow", () => {
    const issued = transition(order(), { type: "ISSUE_CODE", actorId: "super_1" }, codeCtx);
    expect(issued.ok).toBe(true);

    const withHash = { ...issued.next!, issuedCodeHash: "hashed:481920" };
    const wrong = transition(withHash, { type: "SUBMIT_CODE", code: "000000" }, codeCtx);
    expect(wrong.ok).toBe(false);
    expect(wrong.failure).toBe("CODE_MISMATCH");
    expect(wrong.next?.codeAttemptCount).toBe(1);

    const right = transition(withHash, { type: "SUBMIT_CODE", code: "481920" }, codeCtx);
    expect(right.ok).toBe(true);
    expect(right.next?.status).toBe("AWAITING_CONFIRMATION");
  });

  it("locks out after too many wrong codes", () => {
    const state = order({ issuedCodeHash: "hashed:481920", codeAttemptCount: 5 });
    const result = transition(state, { type: "SUBMIT_CODE", code: "481920" }, codeCtx);
    expect(result.failure).toBe("TOO_MANY_ATTEMPTS");
  });

  it("refuses a confirmation method the platform has turned off", () => {
    const result = transition(order(), { type: "SUBMIT_REFERENCE", reference: "X" }, codeCtx);
    expect(result.failure).toBe("MODE_NOT_ALLOWED");
  });

  /**
   * A bill of zero has nothing to reference and nothing to code.
   *
   * A coupon can cover the whole amount, and the order then sat on a screen
   * asking for the UPI reference of a payment nobody could make. Its own
   * action, in every mode, because neither mode applies to a transfer that
   * will never happen -- and whether the amount really is zero is the caller's
   * to check against the order, not the machine's.
   */
  it("lets a zero-rated order be confirmed with nothing entered, in every mode", () => {
    for (const ctx of [utrCtx, codeCtx]) {
      const result = transition(order(), { type: "SUBMIT_NOTHING_DUE" }, ctx);
      expect(result.ok, ctx.mode).toBe(true);
      expect(result.next?.status, ctx.mode).toBe("AWAITING_CONFIRMATION");
    }
  });

  it("and records no reference for it, because there is none", () => {
    // The order summary prints `transactionRef` as "Your reference". A
    // placeholder there would read as one.
    const result = transition(order(), { type: "SUBMIT_NOTHING_DUE" }, utrCtx);
    expect(result.next?.transactionRef).toBeNull();
    expect(result.next?.confirmationCode).toBeNull();
  });

  it("still goes through approval like every other order", () => {
    const submitted = transition(order(), { type: "SUBMIT_NOTHING_DUE" }, utrCtx);
    const approved = transition(submitted.next!, { type: "APPROVE", actorId: "super_1" }, utrCtx);
    expect(approved.next?.status).toBe("APPROVED");
  });

  it("and cannot be used on an order that is already past submission", () => {
    const waiting = order({ status: "AWAITING_CONFIRMATION" });
    expect(transition(waiting, { type: "SUBMIT_NOTHING_DUE" }, utrCtx).failure).toBe(
      "ILLEGAL_TRANSITION",
    );
  });

  /**
   * A code made before the order existed.
   *
   * The owner makes it on the phone -- for an organisation, or for anybody --
   * and the organisation types it in later. It is not the order's own issued
   * code, so `SUBMIT_CODE`'s "no code issued" gate must not apply, and it is
   * the owner's choice, so the confirmation mode must not either.
   */
  it("accepts an advance code in every mode, with no code issued on the order", () => {
    for (const ctx of [utrCtx, codeCtx]) {
      const result = transition(order(), { type: "SUBMIT_ADVANCE_CODE", code: "481920" }, ctx);
      expect(result.ok, ctx.mode).toBe(true);
      expect(result.next?.status, ctx.mode).toBe("AWAITING_CONFIRMATION");
      expect(result.next?.confirmationCode, ctx.mode).toBe("481920");
    }
  });

  it("but only from where a confirmation is still wanted", () => {
    const waiting = order({ status: "AWAITING_CONFIRMATION" });
    expect(transition(waiting, { type: "SUBMIT_ADVANCE_CODE", code: "481920" }, utrCtx).failure).toBe(
      "ILLEGAL_TRANSITION",
    );
    const info = order({ status: "INFO_REQUESTED" });
    expect(transition(info, { type: "SUBMIT_ADVANCE_CODE", code: "481920" }, utrCtx).ok).toBe(true);
  });

  it("and is offered to the organisation whenever a reference would be", () => {
    expect(availableActions(order(), utrCtx, "ORG")).toContain("SUBMIT_ADVANCE_CODE");
    expect(availableActions(order({ status: "AWAITING_CONFIRMATION" }), utrCtx, "ORG")).not.toContain(
      "SUBMIT_ADVANCE_CODE",
    );
  });

  /**
   * The window is the organisation's deadline, not the reviewer's.
   *
   * An order confirmed inside its four hours used to expire anyway if the
   * platform did not approve it in time -- counted from creation, not from
   * the confirmation. The organisation was then told to raise a new request
   * and quote the same reference, with its money attached to an order nobody
   * could approve any more. Once "I have paid" has been said, the order waits
   * for the platform for as long as that takes.
   */
  it("still approves a confirmed order after its window has passed", () => {
    const lateReview = order({
      status: "AWAITING_CONFIRMATION",
      expiresAt: new Date("2026-04-10T09:00:00.000Z"),
    });
    expect(isExpired(lateReview, NOW)).toBe(false);
    const result = transition(lateReview, { type: "APPROVE", actorId: "super_1" }, utrCtx);
    expect(result.ok).toBe(true);
    expect(result.next?.status).toBe("APPROVED");
    expect(availableActions(lateReview, utrCtx, "SUPERADMIN")).toContain("APPROVE");
  });

  it("but an order nobody confirmed still expires", () => {
    const unconfirmed = order({ expiresAt: new Date("2026-04-10T09:00:00.000Z") });
    expect(isExpired(unconfirmed, NOW)).toBe(true);
    const result = transition(unconfirmed, { type: "SUBMIT_REFERENCE", reference: "UTR1" }, utrCtx);
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("EXPIRED");
    expect(result.next?.status).toBe("EXPIRED");
    expect(transition(unconfirmed, { type: "EXPIRE" }, utrCtx).next?.status).toBe("EXPIRED");
  });

  it("and a question from the reviewer does not restart the clock", () => {
    // INFO_REQUESTED is the reviewer's state as much as AWAITING is: the
    // reviewer can reject if no answer comes, and the organisation can answer
    // late without being sent back to the start.
    const asked = order({ status: "INFO_REQUESTED", expiresAt: new Date("2026-04-10T09:00:00.000Z") });
    expect(isExpired(asked, NOW)).toBe(false);
    expect(transition(asked, { type: "EXPIRE" }, utrCtx).failure).toBe("ILLEGAL_TRANSITION");
    expect(transition(asked, { type: "RESUBMIT", reference: "UTR2" }, utrCtx).next?.status).toBe(
      "AWAITING_CONFIRMATION",
    );
  });

  it("reports no deadline for an order that is off the clock", () => {
    // Callers read `minutesRemaining > 0` as "still live", so an order with no
    // deadline must not read as 0 -- that is what an expired one reads as.
    const stale = new Date("2026-04-10T09:00:00.000Z");
    expect(minutesRemaining(order({ expiresAt: stale }), NOW)).toBe(0);
    expect(minutesRemaining(order({ status: "AWAITING_CONFIRMATION", expiresAt: stale }), NOW)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(minutesRemaining(order({ status: "INFO_REQUESTED", expiresAt: stale }), NOW)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(minutesRemaining(order({ status: "APPROVED" }), NOW)).toBe(0);
    expect(minutesRemaining(order({ status: "EXPIRED" }), NOW)).toBe(0);
  });

  it("treats a repeated approval as a no-op", () => {
    const approved = order({ status: "APPROVED" });
    const again = transition(approved, { type: "APPROVE", actorId: "super_1" }, utrCtx);
    expect(again.ok).toBe(true);
    expect(again.idempotent).toBe(true);
    expect(again.next?.status).toBe("APPROVED");
  });

  it("supports request-info then resubmission", () => {
    const awaiting = order({ status: "AWAITING_CONFIRMATION" });
    const info = transition(awaiting, { type: "REQUEST_INFO", actorId: "super_1", note: "Send a screenshot" }, utrCtx);
    expect(info.next?.status).toBe("INFO_REQUESTED");

    const resubmitted = transition(info.next!, { type: "RESUBMIT", reference: "UTR999" }, utrCtx);
    expect(resubmitted.next?.status).toBe("AWAITING_CONFIRMATION");
    expect(resubmitted.next?.transactionRef).toBe("UTR999");
  });

  it("cannot reopen a rejected order", () => {
    const rejected = order({ status: "REJECTED" });
    expect(transition(rejected, { type: "APPROVE", actorId: "s" }, utrCtx).failure).toBe("TERMINAL");
  });

  it("offers the right buttons to each viewer", () => {
    const awaiting = order({ status: "AWAITING_CONFIRMATION" });
    expect(availableActions(awaiting, utrCtx, "SUPERADMIN")).toEqual(
      expect.arrayContaining(["APPROVE", "REJECT", "REQUEST_INFO"]),
    );
    expect(availableActions(order({ status: "APPROVED" }), utrCtx, "ORG")).toEqual([]);
  });
});

// ------------------------------------------------------------------ seats

describe("seat accounting", () => {
  it("counts only working employees against the seat limit", () => {
    expect(isBillable("REGULAR", true)).toBe(true);
    expect(isBillable("NOTICE_PERIOD", true)).toBe(true);
    expect(isBillable("TRAINING", true)).toBe(true);
    expect(isBillable("RESIGNED", true)).toBe(false);
    expect(isBillable("TERMINATED", true)).toBe(false);
    expect(isBillable("INACTIVE", true)).toBe(false);
    expect(isBillable("REGULAR", false)).toBe(false);
  });

  it("allows activation while seats remain", () => {
    const d = canActivateEmployee({ activeEmployees: 9, seats: 10, billingMode: "PAID", now: NOW });
    expect(d.allowed).toBe(true);
    expect(d.seatsRemaining).toBe(1);
  });

  it("blocks activation at the limit with an actionable message", () => {
    const d = canActivateEmployee({ activeEmployees: 10, seats: 10, billingMode: "PAID", now: NOW });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("SEAT_LIMIT_REACHED");
    expect(d.message).toContain("Add seats");
  });

  it("explains the zero-seat case differently", () => {
    const d = canActivateEmployee({ activeEmployees: 0, seats: 0, billingMode: "PAID", now: NOW });
    expect(d.message).toContain("No seats have been purchased");
  });

  it("permits overage during a grace window", () => {
    const d = canActivateEmployee({
      activeEmployees: 10,
      seats: 10,
      billingMode: "PAID",
      graceUntil: new Date("2026-04-20T00:00:00.000Z"),
      now: NOW,
    });
    expect(d.allowed).toBe(true);
    expect(d.overage).toBe(1);
  });

  it("does not meter free/internal organisations", () => {
    const d = canActivateEmployee({ activeEmployees: 500, seats: 0, billingMode: "FREE_INTERNAL", now: NOW });
    expect(d.allowed).toBe(true);
  });

  it("puts an expired trial into read-only rather than locking people out", () => {
    const expired = resolveAccessState(
      { billingMode: "TRIAL", status: "TRIAL", currentPeriodEnd: NOW, trialEndsAt: new Date("2026-04-01") },
      NOW,
    );
    expect(expired).toBe("TRIAL_EXPIRED");
    expect(isReadOnly(expired)).toBe(true);

    const live = resolveAccessState(
      { billingMode: "TRIAL", status: "TRIAL", currentPeriodEnd: NOW, trialEndsAt: new Date("2026-04-30") },
      NOW,
    );
    expect(live).toBe("TRIAL");
    expect(isReadOnly(live)).toBe(false);
  });

  it("flags a lapsed paid subscription as past due", () => {
    expect(
      resolveAccessState(
        { billingMode: "PAID", status: "ACTIVE", currentPeriodEnd: new Date("2026-04-01") },
        NOW,
      ),
    ).toBe("PAST_DUE");
  });

  /**
   * A paying organisation nobody has paid for.
   *
   * Provisioning a PAID organisation without "already paid" writes a full
   * period ahead of it and marks the subscription PAST_DUE, and tells the
   * platform owner it cannot be used until a payment is approved. Judged by
   * the date alone it was ACTIVE: /billing said "Renews on" a cycle away, no
   * prompt to pay, and every write went through for the whole cycle.
   */
  it("treats a paid subscription the platform has marked past due as past due, whatever the date", () => {
    const unpaid = resolveAccessState(
      { billingMode: "PAID", status: "PAST_DUE", currentPeriodEnd: new Date("2027-04-01") },
      NOW,
    );
    expect(unpaid).toBe("PAST_DUE");
    expect(isReadOnly(unpaid)).toBe(true);
  });

  it("and lets an approved payment clear it", () => {
    // Approval writes ACTIVE; the date then decides, as it always did.
    expect(
      resolveAccessState(
        { billingMode: "PAID", status: "ACTIVE", currentPeriodEnd: new Date("2027-04-01") },
        NOW,
      ),
    ).toBe("ACTIVE");
  });

  it("reads only the mark the product writes", () => {
    // SUSPENDED and EXPIRED are on the enum and nothing sets them. A rule for
    // them would be one nobody chose -- and one that could lock a live
    // organisation out the moment it deployed.
    for (const status of ["SUSPENDED", "EXPIRED", "TRIAL"] as const) {
      expect(
        resolveAccessState(
          { billingMode: "PAID", status, currentPeriodEnd: new Date("2027-04-01") },
          NOW,
        ),
        status,
      ).toBe("ACTIVE");
    }
  });

  it("does not let the mark override a trial or a free organisation", () => {
    // The trial's own end date governs it; a free organisation is unmetered
    // because the owner said so, and a stale row status does not outrank that.
    expect(
      resolveAccessState(
        { billingMode: "TRIAL", status: "PAST_DUE", currentPeriodEnd: new Date("2027-04-01") },
        NOW,
      ),
    ).toBe("TRIAL");
    expect(
      resolveAccessState(
        { billingMode: "FREE_INTERNAL", status: "PAST_DUE", currentPeriodEnd: NOW },
        NOW,
      ),
    ).toBe("UNMETERED");
  });
});
