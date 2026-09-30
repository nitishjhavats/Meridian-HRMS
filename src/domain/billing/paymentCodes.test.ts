import { describe, expect, it } from "vitest";

import {
  type AdvanceCodeSpec,
  advanceDiscount,
  carriesDiscount,
  checkAdvanceCode,
  looksLikePaymentCode,
  resolveConfirmationCode,
} from "./paymentCodes";

/**
 * A code handed out before there is an order.
 *
 * The owner makes it on the phone -- "pay four thousand, your code is 481920"
 * -- and the organisation types it in at checkout, at confirmation, or both.
 * These are the rules for what it is worth and when it may be used.
 */

const NOW = new Date("2026-09-12T10:00:00.000Z");
const ORG = "org_1";
const ORDER = "ord_1";

function code(patch: Partial<AdvanceCodeSpec> = {}): AdvanceCodeSpec {
  return {
    id: "pc_1",
    organizationId: null,
    discountPercent: null,
    maxDiscountPaise: null,
    expiresAt: new Date("2026-10-12T10:00:00.000Z"),
    paymentOrderId: null,
    usedAt: null,
    revokedAt: null,
    ...patch,
  };
}

describe("whether an advance code may be used", () => {
  const ctx = { organizationId: ORG, orderId: ORDER, now: NOW };

  it("an open, live, unused code may", () => {
    expect(checkAdvanceCode(code(), ctx).ok).toBe(true);
  });

  it("a withdrawn code may not, and says so before anything else", () => {
    const check = checkAdvanceCode(code({ revokedAt: NOW, usedAt: NOW }), ctx);
    expect(check.ok).toBe(false);
    expect(check.reason).toBe("REVOKED");
  });

  it("a spent code may not", () => {
    expect(checkAdvanceCode(code({ usedAt: NOW }), ctx).reason).toBe("USED");
  });

  it("a code for one organisation refuses every other", () => {
    expect(checkAdvanceCode(code({ organizationId: "org_2" }), ctx).reason).toBe(
      "WRONG_ORGANISATION",
    );
    expect(checkAdvanceCode(code({ organizationId: ORG }), ctx).ok).toBe(true);
  });

  it("a code applied to another order stays with that order", () => {
    expect(checkAdvanceCode(code({ paymentOrderId: "ord_9" }), ctx).reason).toBe(
      "BOUND_ELSEWHERE",
    );
  });

  it("but the order it was applied to may bring it back to confirm", () => {
    // Applied at checkout, priced in, and now the organisation has paid and is
    // typing it again. That is the one order the binding is for.
    expect(checkAdvanceCode(code({ paymentOrderId: ORDER }), ctx).ok).toBe(true);
  });

  it("and at checkout, with no order yet, a bound code is refused", () => {
    expect(
      checkAdvanceCode(code({ paymentOrderId: ORDER }), { ...ctx, orderId: null }).reason,
    ).toBe("BOUND_ELSEWHERE");
  });

  it("an expired code may not", () => {
    expect(checkAdvanceCode(code({ expiresAt: NOW }), ctx).reason).toBe("EXPIRED");
  });

  it("every refusal carries a sentence the buyer can act on", () => {
    for (const patch of [
      { revokedAt: NOW },
      { usedAt: NOW },
      { organizationId: "org_2" },
      { paymentOrderId: "ord_9" },
      { expiresAt: NOW },
    ]) {
      const check = checkAdvanceCode(code(patch), ctx);
      expect(check.message, JSON.stringify(patch)).toMatch(/payment code/);
    }
  });
});

describe("what a code takes off", () => {
  it("nothing, when it carries no discount", () => {
    expect(carriesDiscount(code())).toBe(false);
    expect(carriesDiscount(code({ discountPercent: 0 }))).toBe(false);
    expect(advanceDiscount(500_000, code())).toEqual({ discountPaise: 0, payablePaise: 500_000 });
  });

  it("a percentage of what is owed now, not of the list price", () => {
    // "Twenty per cent off" on the phone is twenty per cent of the bill the
    // customer is looking at, which may already have a coupon on it.
    expect(advanceDiscount(400_000, code({ discountPercent: 20 }))).toEqual({
      discountPaise: 80_000,
      payablePaise: 320_000,
    });
  });

  it("rounds half-up to the paisa", () => {
    expect(advanceDiscount(100_001, code({ discountPercent: 12.5 })).discountPaise).toBe(12_500);
  });

  it("is capped when a ceiling was set", () => {
    expect(
      advanceDiscount(500_000, code({ discountPercent: 50, maxDiscountPaise: 100_000 })),
    ).toEqual({ discountPaise: 100_000, payablePaise: 400_000 });
  });

  it("never turns a bill into a refund", () => {
    expect(advanceDiscount(1_000, code({ discountPercent: 100 })).payablePaise).toBe(0);
    expect(advanceDiscount(0, code({ discountPercent: 50 }))).toEqual({
      discountPaise: 0,
      payablePaise: 0,
    });
  });
});

describe("which code was just typed in", () => {
  const base = { organizationId: ORG, orderId: ORDER, now: NOW };

  it("the order's own code wins outright", () => {
    // Even with an advance code that would also have matched: the issuer
    // looked at this request and vouched for its payment.
    const result = resolveConfirmationCode({ ...base, orderCodeMatches: true, advance: code() });
    expect(result.kind).toBe("ORDER");
  });

  it("nothing matched", () => {
    const result = resolveConfirmationCode({ ...base, orderCodeMatches: false, advance: null });
    expect(result).toEqual({ kind: "NONE", check: null });
  });

  it("an advance code that fails its own check is refused with the reason", () => {
    const result = resolveConfirmationCode({
      ...base,
      orderCodeMatches: false,
      advance: code({ usedAt: NOW }),
    });
    expect(result.kind).toBe("NONE");
    expect(result.kind === "NONE" && result.check?.reason).toBe("USED");
  });

  it("an advance code with no discount confirms and changes nothing", () => {
    const result = resolveConfirmationCode({ ...base, orderCodeMatches: false, advance: code() });
    expect(result.kind).toBe("ADVANCE");
    expect(result.kind === "ADVANCE" && result.reprice).toBe(false);
  });

  it("a discount code typed here for the first time re-prices the order", () => {
    const result = resolveConfirmationCode({
      ...base,
      orderCodeMatches: false,
      advance: code({ discountPercent: 10 }),
    });
    expect(result.kind === "ADVANCE" && result.reprice).toBe(true);
  });

  it("but not twice: one applied at checkout was priced in already", () => {
    const result = resolveConfirmationCode({
      ...base,
      orderCodeMatches: false,
      advance: code({ discountPercent: 10, paymentOrderId: ORDER }),
    });
    expect(result.kind === "ADVANCE" && result.reprice).toBe(false);
  });
});

describe("telling a payment code from a coupon at checkout", () => {
  it("six digits is a payment code", () => {
    expect(looksLikePaymentCode("481920")).toBe(true);
    expect(looksLikePaymentCode(" 481920 ")).toBe(true);
  });

  it("anything else is not", () => {
    for (const value of ["LAUNCH10", "48192", "4819200", "48A920", "", null, undefined]) {
      expect(looksLikePaymentCode(value), String(value)).toBe(false);
    }
  });
});
