import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext } from "@/lib/auth/context";
import { paidPeriodEnd } from "@/domain/billing/period";

import { createFakeBillingDb, orderRow } from "./fakeBillingDb.testkit";

/**
 * One payment, credited once -- however many times "approve" arrives.
 *
 * `settleApproval` decides on the order it was handed, which was read before
 * the transaction began. Two approvals of the same order -- the Approve button
 * pressed twice, two superadmins in two tabs, the issued code typed twice in
 * parallel -- both read it as still waiting, and before this fix both
 * committed: the paid period was extended twice and two history rows written
 * for one payment. A request rejected while the approval was being decided
 * was flipped to APPROVED and credited anyway.
 *
 * These run the real `settleApproval` against an in-memory database. The
 * stale snapshot passed in is exactly what the second request would hold.
 */

const fake = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof createFakeBillingDb> }));

vi.mock("@/lib/db/prisma", () => ({
  get prisma() {
    return fake.db.prisma;
  },
}));
vi.mock("@/lib/audit", () => ({ writeAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/notify", () => ({
  notify: { toOrgRoles: vi.fn(async () => undefined), toSuperadmins: vi.fn(async () => undefined) },
}));

const { settleApproval } = await import("./approval");
const { writeAudit } = await import("@/lib/audit");
const { notify } = await import("@/lib/notify");

const ctx = { userId: "superadmin_1" } as unknown as AuthContext;
const input = { actorUserId: "superadmin_1", mode: "BOTH" as const, via: "button" as const };

const PERIOD_END = new Date("2027-03-01T00:00:00.000Z");

function seed() {
  fake.db = createFakeBillingDb();
  const order = orderRow();
  fake.db.state.paymentOrders.set(order.id, order);
  fake.db.state.subscriptions.set(order.organizationId, {
    organizationId: order.organizationId,
    seats: 5,
    status: "ACTIVE",
    billingMode: "PAID",
    currentPeriodStart: new Date("2026-03-01T00:00:00.000Z"),
    currentPeriodEnd: PERIOD_END,
  });
  return order;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("settleApproval credits a payment exactly once", () => {
  it("a second approval holding the same stale order credits nothing", async () => {
    const order = seed();
    const staleA = { ...order };
    const staleB = { ...order };

    const first = await settleApproval(ctx, staleA, input);
    const second = await settleApproval(ctx, staleB, input);

    expect(first.status).toBe("APPROVED");
    expect(second.status).toBe("APPROVED");
    // One payment, one extension: twelve months from the old end, not twenty-four.
    expect(fake.db.state.subscriptions.get(order.organizationId)?.currentPeriodEnd).toEqual(
      paidPeriodEnd(PERIOD_END, order.periodMonths),
    );
    expect(fake.db.state.subscriptionHistory).toHaveLength(1);
    expect(fake.db.state.paymentOrderEvents.filter((e) => e.toStatus === "APPROVED")).toHaveLength(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(notify.toOrgRoles).toHaveBeenCalledTimes(1);
  });

  it("two approvals racing in parallel credit once", async () => {
    const order = seed();

    const results = await Promise.all([
      settleApproval(ctx, { ...order }, input),
      settleApproval(ctx, { ...order }, input),
    ]);

    expect(results.map((r) => r.status)).toEqual(["APPROVED", "APPROVED"]);
    expect(fake.db.state.subscriptionHistory).toHaveLength(1);
    expect(fake.db.state.paymentOrderEvents.filter((e) => e.toStatus === "APPROVED")).toHaveLength(1);
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(notify.toOrgRoles).toHaveBeenCalledTimes(1);
  });

  it("an order rejected after it was read is not approved or credited", async () => {
    const order = seed();
    const stale = { ...order };
    // Another superadmin rejects it between this request's read and its write.
    fake.db.state.paymentOrders.set(order.id, { ...order, status: "REJECTED", reviewNote: "No such UTR" });

    await expect(settleApproval(ctx, stale, input)).rejects.toThrow();

    expect(fake.db.state.paymentOrders.get(order.id)?.status).toBe("REJECTED");
    expect(fake.db.state.subscriptions.get(order.organizationId)?.currentPeriodEnd).toEqual(PERIOD_END);
    expect(fake.db.state.subscriptionHistory).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
    expect(notify.toOrgRoles).not.toHaveBeenCalled();
  });

  it("an order resubmitted with a new reference after it was read is not approved on the old read", async () => {
    const order = seed();
    const stale = { ...order };
    // Sent back for information and resubmitted with another UTR in between:
    // the status is AWAITING_CONFIRMATION again, but it is not the row the
    // approver looked at.
    fake.db.state.paymentOrders.set(order.id, {
      ...order,
      transactionRef: "UTR-NOBODY-CHECKED",
      updatedAt: new Date(order.updatedAt.getTime() + 60_000),
    });

    await expect(settleApproval(ctx, stale, input)).rejects.toThrow();

    expect(fake.db.state.paymentOrders.get(order.id)?.status).toBe("AWAITING_CONFIRMATION");
    expect(fake.db.state.subscriptionHistory).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("a single approval still credits seats and the period", async () => {
    const order = seed();

    const approved = await settleApproval(ctx, order, { ...input, note: "Paid in full" });

    expect(approved.status).toBe("APPROVED");
    expect(approved.reviewedById).toBe("superadmin_1");
    expect(approved.issuedCodeHash).toBeNull();
    const sub = fake.db.state.subscriptions.get(order.organizationId);
    expect(sub?.seats).toBe(order.userCount);
    expect(sub?.currentPeriodEnd).toEqual(paidPeriodEnd(PERIOD_END, order.periodMonths));
    expect(fake.db.state.organizations.get(order.organizationId)?.seatLimit).toBe(order.userCount);
    expect(fake.db.state.subscriptionHistory).toHaveLength(1);
  });
});
