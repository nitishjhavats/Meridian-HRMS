/**
 * Round-12 smoke run for payment codes, against the LOCAL database.
 *
 *   npx tsx --env-file=.env scripts/smoke-payment-codes.ts
 *
 * Builds real contexts through `loadContext` (no HTTP, no passwords) and walks
 * the whole chain at the service layer: an advance code with a discount priced
 * in at checkout and confirmed with one tap; an advance code typed at
 * confirmation re-pricing the order; and an order-bound code approving the
 * order on entry and crediting seats. Every assertion is read back from the
 * database. Refuses to run against anything but localhost.
 */

import { prisma } from "@/lib/db/prisma";
import { type AuthContext, loadContext } from "@/lib/auth/context";
import { effectivePermissions } from "@/lib/auth/permissions";
import { createOrder, quoteOrder, submitBoundCode, submitConfirmationCode } from "@/services/billing/orders";
import { issueAdvanceCode, issueConfirmationCode, listPaymentCodes, revokeAdvanceCode } from "@/services/platform/payments";

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Refusing: DATABASE_URL is not local.");
  }

  const superadmin = await prisma.user.findFirstOrThrow({ where: { role: "SUPERADMIN" } });
  const owner = await prisma.user.findFirstOrThrow({
    where: { role: "ORG_OWNER", organization: { slug: "acme" } },
  });
  // Built by hand: `loadContext` reads the impersonation cookie for a superadmin,
  // and there is no request here to read it from.
  const platform: AuthContext = {
    userId: superadmin.id,
    sessionId: "smoke",
    email: superadmin.email,
    name: superadmin.name ?? "",
    role: "SUPERADMIN",
    organizationId: null,
    employeeId: null,
    permissions: effectivePermissions("SUPERADMIN", []),
    modules: new Set(),
    accessState: "UNMETERED",
    isSuperadmin: true,
    readOnlyView: false,
    impersonating: null,
    mustChangePassword: false,
    organization: null,
  };
  const org = await loadContext({ sub: owner.id, sid: "smoke", org: owner.organizationId, role: "ORG_OWNER" });
  const orgId = owner.organizationId as string;

  console.log("\n1. Advance code with 10% off, applied at checkout, confirmed with one tap");
  const a = await issueAdvanceCode(platform, { organizationId: orgId, discountPercent: 10, validDays: 7, note: "smoke A" });
  const plain = await quoteOrder(org, { userCount: 10, periodMonths: 1 });
  const withCode = await quoteOrder(org, { userCount: 10, periodMonths: 1, couponCode: a.code });
  assert(withCode.couponError === null, "the code is accepted by the quote");
  assert(withCode.paymentCode?.percent === 10, "the quote names the code's percent");
  assert(withCode.payablePaise === plain.payablePaise - Math.round(plain.payablePaise / 10), "payable is 10% less");
  const orderA = await createOrder(org, { userCount: 10, periodMonths: 1, couponCode: a.code });
  const boundA = await prisma.paymentCode.findUnique({ where: { paymentOrderId: orderA.id } });
  assert(boundA?.id === a.id && boundA.appliedAt && !boundA.usedAt, "the code is bound to the order, applied, not yet spent");
  assert(orderA.payablePaise === withCode.payablePaise, "the order is priced with the discount");
  const again = await quoteOrder(org, { userCount: 5, periodMonths: 1, couponCode: a.code });
  assert(again.couponError?.includes("another payment request"), "a bound code is refused at a second checkout");
  const confirmedA = await submitBoundCode(org, orderA.id);
  assert(confirmedA.status === "AWAITING_CONFIRMATION", "one tap moves it to the queue, not to approved");
  const spentA = await prisma.paymentCode.findUnique({ where: { id: a.id } });
  assert(spentA?.usedAt != null, "the code is spent");
  assert(confirmedA.payablePaise === orderA.payablePaise, "no second discount");

  console.log("\n2. Advance code typed at confirmation re-prices the order");
  const b = await issueAdvanceCode(platform, { discountPercent: 20, maxDiscountPaise: 20_000, validDays: 7, note: "smoke B" });
  const orderB = await createOrder(org, { userCount: 10, periodMonths: 1 });
  const wrong = await submitConfirmationCode(org, orderB.id, "000000").catch((e: Error) => e);
  assert(wrong instanceof Error, "a wrong code is refused");
  const confirmedB = await submitConfirmationCode(org, orderB.id, b.code);
  assert(confirmedB.status === "AWAITING_CONFIRMATION", "an advance code goes to the queue");
  const expected = Math.min(Math.round(orderB.payablePaise * 0.2), 20_000);
  assert(confirmedB.payablePaise === orderB.payablePaise - expected, `re-priced by the capped discount (${expected} paise)`);
  assert(confirmedB.discountPaise === expected, "discountPaise records it");
  const eventsB = await prisma.paymentOrderEvent.findMany({ where: { paymentOrderId: orderB.id } });
  assert(eventsB.some((e) => /re-priced from/.test(e.note ?? "")), "the event records old to new");
  const reuse = await submitConfirmationCode(org, (await createOrder(org, { userCount: 3, periodMonths: 1 })).id, b.code).catch((e: Error) => e);
  assert(reuse instanceof Error && /already been used/.test(reuse.message), "a spent code is refused with the reason");

  console.log("\n3. Order-bound code approves on entry and credits the seats");
  const before = await prisma.subscription.findUnique({ where: { organizationId: orgId } });
  const orderC = await createOrder(org, { userCount: (before?.seats ?? 0) + 2, periodMonths: 1 });
  const issued = await issueConfirmationCode(platform, orderC.id);
  const confirmedC = await submitConfirmationCode(org, orderC.id, issued.code);
  assert(confirmedC.status === "APPROVED", "the order is approved on entry");
  // The organisation's response no longer says who reviewed it; the row does.
  const rowC = await prisma.paymentOrder.findUnique({ where: { id: orderC.id } });
  assert(rowC?.reviewedById === superadmin.id, "recorded as the issuer's approval");
  assert(!("issuedCodeHash" in confirmedC), "the response carries no code hash");
  const after = await prisma.subscription.findUnique({ where: { organizationId: orgId } });
  assert((after?.seats ?? 0) === (before?.seats ?? 0) + 2, "seats are credited");
  const history = await prisma.subscriptionHistory.findFirst({ where: { paymentOrderId: orderC.id } });
  assert(history?.createdById === superadmin.id, "history names the issuer");
  const audit = await prisma.auditLog.findFirst({ where: { entityId: orderC.id, action: "payment.approved" }, orderBy: { createdAt: "desc" } });
  assert(audit?.actorId === owner.id && (audit.metadata as { via?: string })?.via === "issued_code", "the audit row names who typed it and how");

  console.log("\n4. The list and the withdrawal");
  const c = await issueAdvanceCode(platform, { validDays: 1, note: "smoke C" });
  const rows = await listPaymentCodes(platform, { state: "all" });
  assert(rows.some((r) => r.id === c.id && r.state === "LIVE"), "a fresh code is listed live");
  assert(rows.some((r) => r.id === a.id && r.state === "USED" && r.orderNumber === orderA.orderNumber), "a spent code shows the order it confirmed");
  assert(rows.some((r) => r.kind === "ORDER" && r.orderId === orderC.id && r.state === "USED"), "the order-bound code is in the same list");
  const revoked = await revokeAdvanceCode(platform, c.id);
  assert(revoked.state === "REVOKED", "withdrawn");
  const afterRevoke = await quoteOrder(org, { userCount: 2, periodMonths: 1, couponCode: c.code });
  assert(/withdrawn/.test(afterRevoke.couponError ?? ""), "a withdrawn code says so at checkout");

  console.log("\nAll good.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
