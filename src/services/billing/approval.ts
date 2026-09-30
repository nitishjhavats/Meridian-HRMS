import type { PaymentOrder } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { ConflictError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { validateCoupon } from "@/domain/billing/pricing";
import { type ConfirmationMode, transition } from "@/domain/billing/orderMachine";
import { paidPeriodEnd, paidPeriodStart } from "@/domain/billing/period";

/**
 * The moment money becomes entitlement.
 *
 * Lifted out of the platform owner's `approveOrder` so that it can happen from
 * two places without being written twice: the Approve button, and an
 * organisation typing in a code the owner issued against this very order.
 * Issuing that code *was* the approval, given in advance -- the owner looked
 * at this request, saw the money, and handed over six digits that mean "yes".
 * Making them come back and press a button as well was one more thing for a
 * customer to wait on.
 *
 * What does not move: the window is checked again here, the coupon is
 * re-validated, and seats, history, redemption and status are written in one
 * transaction. No guard on `ctx` -- the callers decide who may get here, and
 * both of them do.
 */

export interface ApprovalInput {
  /**
   * Who the approval is recorded as: `reviewedById` on the order, `createdById`
   * on the history row, `actorId` on the event. Through the button it is the
   * superadmin pressing it; through an issued code it is the superadmin who
   * issued it. The audit row is written as `ctx` either way, because that is
   * who caused it to happen now.
   */
  actorUserId: string;
  mode: ConfirmationMode;
  note?: string;
  via: "button" | "issued_code";
}

function toState(order: PaymentOrder) {
  return {
    status: order.status,
    expiresAt: order.expiresAt,
    issuedCodeHash: order.issuedCodeHash,
    codeAttemptCount: order.codeAttemptCount,
    confirmationCode: order.confirmationCode,
    transactionRef: order.transactionRef,
  };
}

export async function settleApproval(
  ctx: AuthContext,
  order: PaymentOrder,
  input: ApprovalInput,
): Promise<PaymentOrder> {
  const { actorUserId, note } = input;
  const now = new Date();

  const result = transition(
    toState(order),
    { type: "APPROVE", actorId: actorUserId, note },
    { now, mode: input.mode },
  );

  if (!result.ok) {
    if (result.failure === "EXPIRED") {
      await prisma.paymentOrder.update({ where: { id: order.id }, data: { status: "EXPIRED" } });
    }
    throw new ConflictError(result.message ?? "This request can no longer be approved.");
  }
  // Already approved — say so without crediting anything a second time.
  if (result.idempotent) return order;

  // Re-validate the coupon at approval time. It may have expired or hit its cap
  // while the request sat in the queue.
  if (order.couponId) {
    const coupon = await prisma.coupon.findUnique({ where: { id: order.couponId } });
    const check = validateCoupon(
      coupon
        ? {
            code: coupon.code,
            percent: Number(coupon.percent),
            maxDiscountPaise: coupon.maxDiscountPaise,
            startsAt: coupon.startsAt,
            expiresAt: coupon.expiresAt,
            maxRedemptions: coupon.maxRedemptions,
            redemptionCount: coupon.redemptionCount,
            maxPerOrganisation: coupon.maxPerOrganisation,
            minUserCount: coupon.minUserCount,
            maxUserCount: coupon.maxUserCount,
            firstPurchaseOnly: coupon.firstPurchaseOnly,
            appliesToOrgId: coupon.appliesToOrgId,
            active: coupon.active,
          }
        : null,
      {
        userCount: order.userCount,
        organizationId: order.organizationId,
        now: order.createdAt,
        /**
         * The buyer's history, counted here too.
         *
         * Both limits are about the organisation rather than the offer, so
         * neither can be read off the coupon row -- and this is the last gate
         * before money moves. An order that sat in the queue while the same
         * organisation spent its last allowed use elsewhere must not be waved
         * through because the earlier check passed.
         *
         * This order is excluded from both counts: it has no redemption row
         * yet, and it is not approved yet either, so counting it would refuse
         * every first purchase at the moment it became one.
         */
        organizationRedemptions: await prisma.couponRedemption.count({
          where: {
            organizationId: order.organizationId,
            couponId: order.couponId,
            NOT: { paymentOrderId: order.id },
          },
        }),
        hasPurchasedBefore:
          (await prisma.paymentOrder.count({
            where: {
              organizationId: order.organizationId,
              status: "APPROVED",
              NOT: { id: order.id },
            },
          })) > 0,
      },
    );
    if (!check.ok) {
      throw new ConflictError(
        `The coupon on this order is no longer valid (${check.message}). Reject it and ask the organisation to reorder.`,
      );
    }
  }

  // Settled inside the transaction, from the subscription as it is at that
  // moment: a renewal approved early starts where the paid period ends, not
  // at the click. `periodEnd` is read after the transaction for the message.
  let periodEnd = paidPeriodEnd(now, order.periodMonths);

  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.subscription.findUnique({
      where: { organizationId: order.organizationId },
    });

    const periodStart = paidPeriodStart(existing, now);
    periodEnd = paidPeriodEnd(periodStart, order.periodMonths);

    const nextSeats = Math.max(existing?.seats ?? 0, order.userCount);

    if (existing) {
      await tx.subscription.update({
        where: { organizationId: order.organizationId },
        data: {
          seats: nextSeats,
          status: "ACTIVE",
          billingMode: "PAID",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextBillingDate: periodEnd,
          graceUntil: null,
          pricePerUserPaise: order.pricePerUserPaise,
        },
      });
    } else {
      await tx.subscription.create({
        data: {
          organizationId: order.organizationId,
          seats: nextSeats,
          status: "ACTIVE",
          billingMode: "PAID",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          nextBillingDate: periodEnd,
          pricePerUserPaise: order.pricePerUserPaise,
        },
      });
    }

    await tx.organization.update({
      where: { id: order.organizationId },
      data: { seatLimit: nextSeats, status: "ACTIVE" },
    });

    await tx.subscriptionHistory.create({
      data: {
        organizationId: order.organizationId,
        paymentOrderId: order.id,
        previousSeats: existing?.seats ?? 0,
        newSeats: nextSeats,
        previousPeriodEnd: existing?.currentPeriodEnd ?? null,
        newPeriodEnd: periodEnd,
        amountPaise: order.payablePaise,
        note: note ?? null,
        createdById: actorUserId,
      },
    });

    if (order.couponId) {
      // The unique constraint on (couponId, orderId) is what makes a concurrent
      // double approval impossible to redeem twice.
      await tx.couponRedemption.create({
        data: {
          couponId: order.couponId,
          paymentOrderId: order.id,
          organizationId: order.organizationId,
          discountPaise: order.discountPaise,
        },
      });
      await tx.coupon.update({
        where: { id: order.couponId },
        data: { redemptionCount: { increment: 1 } },
      });
    }

    const saved = await tx.paymentOrder.update({
      where: { id: order.id },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        reviewedById: actorUserId,
        reviewNote: note ?? null,
        // A consumed code must not remain verifiable.
        issuedCodeHash: null,
        issuedCodeCipher: null,
      },
    });

    await tx.paymentOrderEvent.create({
      data: {
        paymentOrderId: order.id,
        fromStatus: order.status,
        toStatus: "APPROVED",
        note: note ?? null,
        actorId: actorUserId,
      },
    });

    return saved;
  });

  await writeAudit(ctx, {
    action: "payment.approved",
    entityType: "PaymentOrder",
    entityId: order.id,
    organizationId: order.organizationId,
    before: { status: order.status },
    after: { status: "APPROVED", seats: updated.userCount, amountPaise: updated.payablePaise },
    metadata: { via: input.via, approvedAs: actorUserId },
  });

  await notify.toOrgRoles(order.organizationId, ["ORG_OWNER", "ADMIN"], {
    type: "payment.approved",
    title: "Payment approved",
    body: `${order.userCount} seats are now active until ${periodEnd.toLocaleDateString("en-IN")}.`,
    link: "/billing",
  });

  return updated;
}
