import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PLATFORM_NAV } from "@/lib/navigation";

/**
 * Codes the platform owner hands out, and what each one is allowed to do.
 *
 * The decisions -- which code was typed, what it takes off, whether it may be
 * used -- are pure and tested in `domain/billing/paymentCodes.test.ts`. What
 * is pinned here is the part that needs a database and is therefore read as
 * source: which branch credits seats without a human pressing Approve, where
 * the code is bound so two checkouts cannot both win it, and what never
 * reaches the audit log.
 */

const ORDERS = "src/services/billing/orders.ts";
const PLATFORM = "src/services/platform/payments.ts";
const APPROVAL = "src/services/billing/approval.ts";
const AUDIT = "src/lib/audit.ts";

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("only the code issued against the order approves it", () => {
  it("the order-bound path settles the approval, as the issuer", () => {
    /**
     * Issuing a code against a request already in the queue *was* the
     * approval: the owner looked at this request, saw the money, and handed
     * over six digits that mean yes. So typing them in completes it, recorded
     * as the issuer's decision.
     */
    const body = bodyOf(ORDERS, "export async function submitConfirmationCode");
    expect(body).toMatch(/if \(order\.codeIssuedById\) \{\s*return settleApproval\(/);
    expect(body).toMatch(/actorUserId: order\.codeIssuedById/);
    expect(body).toMatch(/via: "issued_code"/);
  });

  it("and the advance-code path never does", () => {
    // The money has not been seen when an advance code is made. It confirms;
    // it does not approve.
    const body = bodyOf(ORDERS, "async function confirmWithAdvanceCode");
    expect(body).not.toMatch(/settleApproval/);
    expect(body).toMatch(/type: "SUBMIT_ADVANCE_CODE"/);
    expect(body).toMatch(/notify\.toSuperadmins/);
  });

  it("the button is still the superadmin's alone", () => {
    const body = bodyOf(PLATFORM, "export async function approveOrder");
    expect(body).toMatch(/requireSuperadmin\(ctx\)/);
    expect(body).toMatch(/requirePermission\(ctx, "platform\.payment\.approve"\)/);
    expect(body).toMatch(/via: "button"/);
  });

  it("and the crediting itself has no guard, because its two callers do", () => {
    const body = code(APPROVAL);
    expect(body).not.toMatch(/requireSuperadmin|requirePermission/);
    // The window and the coupon are still checked at the moment of crediting.
    expect(body).toMatch(/type: "APPROVE"/);
    expect(body).toMatch(/validateCoupon\(/);
  });
});

describe("a code is spent exactly once", () => {
  it("binding at checkout happens in the order's own transaction, only if still free", () => {
    /**
     * Two checkouts racing the same code both pass the quote. The
     * `paymentOrderId: null` condition is what makes only one of them win,
     * and being inside the transaction is what rolls the loser's order back
     * rather than leaving it priced with a discount it does not hold.
     */
    const body = bodyOf(ORDERS, "export async function createOrder");
    const tx = body.indexOf("prisma.$transaction");
    const bind = body.indexOf("tx.paymentCode.updateMany");
    expect(tx).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(tx);
    expect(body).toMatch(/usedAt: null, revokedAt: null, paymentOrderId: null/);
    expect(body).toMatch(/if \(bound\.count === 0\)/);
  });

  it("spending at confirmation is a conditional write, not a read then a write", () => {
    const body = bodyOf(ORDERS, "async function confirmWithAdvanceCode");
    expect(body).toMatch(/tx\.paymentCode\.updateMany/);
    expect(body).toMatch(/if \(spent\.count === 0\)/);
    // Only a free code, or the one bound to this very order.
    expect(body).toMatch(/OR: \[\{ paymentOrderId: null \}, \{ paymentOrderId: order\.id \}\]/);
  });

  it("re-pricing and spending are one transaction", () => {
    const body = bodyOf(ORDERS, "async function confirmWithAdvanceCode");
    const tx = body.indexOf("prisma.$transaction");
    expect(body.indexOf("tx.paymentCode.updateMany")).toBeGreaterThan(tx);
    expect(body.indexOf("payablePaise: repriced.payablePaise")).toBeGreaterThan(tx);
  });
});

describe("guessing is bounded from every direction", () => {
  it("an advance code is rate-limited per organisation, not only per order", () => {
    // A new order is a new per-order key. Without the organisation key, the
    // guessing budget resets with every request raised.
    const body = bodyOf(ORDERS, "export async function submitConfirmationCode");
    expect(body).toMatch(/enforce\("paymentCode", `verify:\$\{ctx\.organizationId\}:\$\{orderId\}`\)/);
    expect(body).toMatch(/enforce\("paymentCode", `advance:\$\{ctx\.organizationId\}`/);
  });

  it("a wrong code still counts against the order's attempts", () => {
    const body = bodyOf(ORDERS, "export async function submitConfirmationCode");
    expect(body).toMatch(/verifyCode: \(\) => resolved\.kind === "ORDER"/);
    expect(body).toMatch(/codeAttemptCount: result\.next\.codeAttemptCount/);
  });
});

describe("the digits never reach the audit log", () => {
  it("issuing records everything about the code except the code", () => {
    const body = bodyOf(PLATFORM, "export async function issueAdvanceCode");
    const audit = body.slice(body.indexOf("writeAudit("), body.indexOf("});", body.indexOf("writeAudit(")));
    expect(audit).not.toMatch(/plaintext/);
    expect(audit).not.toMatch(/codeCipher/);
    expect(audit).not.toMatch(/codeHash/);
  });

  it("and the stored forms are redacted wherever they might be echoed", () => {
    const body = code(AUDIT);
    expect(body).toMatch(/"codeHash",/);
    expect(body).toMatch(/"codeCipher",/);
  });

  it("every showing is written down", () => {
    const body = bodyOf(PLATFORM, "export async function revealAdvanceCode");
    expect(body).toMatch(/payment\.advance_code_revealed/);
  });
});

describe("the owner can find the codes", () => {
  it("there is a tab, under Payments, for those who may approve", () => {
    const customers = PLATFORM_NAV.find((s) => s.label === "Customers");
    const item = customers?.items.find((i) => i.href === "/platform/payment-codes");
    expect(item).toBeDefined();
    expect(item?.permission).toBe("platform.payment.approve");
    const payments = customers?.items.findIndex((i) => i.href === "/platform/payments") ?? -1;
    const codes = customers?.items.findIndex((i) => i.href === "/platform/payment-codes") ?? -1;
    expect(codes).toBe(payments + 1);
  });

  it("and both kinds are in one list", () => {
    // The order-bound code lived only in a row action on Payments. "The code
    // I gave Jivonik on Tuesday" should not need the owner to remember which
    // kind it was.
    const body = bodyOf(PLATFORM, "export async function listPaymentCodes");
    expect(body).toMatch(/prisma\.paymentCode\.findMany/);
    expect(body).toMatch(/codeIssuedAt: \{ not: null \}/);
  });
});
