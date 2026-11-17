import type { PaymentOrder, PaymentOrderStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { generateConfirmationCode } from "@/lib/auth/password";
import { decryptOptional, encryptField } from "@/lib/crypto/field";
import { validateCoupon } from "@/domain/billing/pricing";
import {
  type OrderState,
  clockRunning,
  isExpired,
  minutesRemaining,
  transition,
} from "@/domain/billing/orderMachine";
import { getPlatformPricing } from "../billing/orders";
import { settleApproval } from "../billing/approval";
import { ORDER_CHANGED_MESSAGE, writeOrderIfUnchanged } from "../billing/orderWrite";
import { withoutIssuedCode } from "../billing/customerOrder";
import { randomNumericCode, sha256 } from "@/lib/crypto/field";

/**
 * The platform owner's side of payments.
 *
 * Approval is the moment money becomes entitlement, so it is the most carefully
 * guarded operation in the product:
 *
 *   - the 4-hour window is checked again here, not just when the page rendered;
 *   - the coupon is re-validated, because it may have expired or been exhausted
 *     between the organisation ordering and the owner approving;
 *   - seats, subscription history and coupon redemption all move inside one
 *     transaction, so a crash cannot credit seats without recording why;
 *   - approving twice is a no-op rather than a double credit.
 */

export interface OrderFilters {
  status?: PaymentOrderStatus[];
  organizationId?: string;
  from?: Date;
  to?: Date;
  couponCode?: string;
  minUserCount?: number;
  maxUserCount?: number;
  search?: string;
  take?: number;
  skip?: number;
}

export interface OrderRow {
  id: string;
  orderNumber: string;
  organizationId: string;
  organizationName: string;
  userCount: number;
  previousSeats: number;
  pricePerUserPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  payablePaise: number;
  couponCode: string | null;
  status: PaymentOrderStatus;
  confirmationCode: string | null;
  transactionRef: string | null;
  payerNote: string | null;
  hasIssuedCode: boolean;
  createdAt: Date;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  expiresAt: Date;
  minutesRemaining: number;
}

function buildWhere(filters: OrderFilters): Prisma.PaymentOrderWhereInput {
  return {
    ...(filters.status?.length ? { status: { in: filters.status } } : {}),
    ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
    ...(filters.couponCode ? { couponCode: filters.couponCode.toUpperCase() } : {}),
    ...(filters.from || filters.to
      ? { createdAt: { ...(filters.from ? { gte: filters.from } : {}), ...(filters.to ? { lte: filters.to } : {}) } }
      : {}),
    ...(filters.minUserCount != null || filters.maxUserCount != null
      ? {
          userCount: {
            ...(filters.minUserCount != null ? { gte: filters.minUserCount } : {}),
            ...(filters.maxUserCount != null ? { lte: filters.maxUserCount } : {}),
          },
        }
      : {}),
    ...(filters.search
      ? {
          OR: [
            { orderNumber: { contains: filters.search, mode: "insensitive" } },
            { transactionRef: { contains: filters.search, mode: "insensitive" } },
            { organization: { name: { contains: filters.search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
}

export async function listOrders(
  ctx: AuthContext,
  filters: OrderFilters = {},
): Promise<{ rows: OrderRow[]; total: number }> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.read");

  const where = buildWhere(filters);
  const [orders, total] = await Promise.all([
    prisma.paymentOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: filters.take ?? 50,
      skip: filters.skip ?? 0,
      include: { organization: { select: { name: true } } },
    }),
    prisma.paymentOrder.count({ where }),
  ]);

  // Sweep anything that has aged out, so the queue never shows an actionable
  // button on a request that can no longer be approved.
  const now = new Date();
  const stale = orders.filter((o) => isExpired(toState(o), now));
  if (stale.length > 0) {
    await prisma.paymentOrder.updateMany({
      where: { id: { in: stale.map((o) => o.id) } },
      data: { status: "EXPIRED" },
    });
  }

  return {
    rows: orders.map((order) => {
      const expired = isExpired(toState(order), now);
      return {
        id: order.id,
        orderNumber: order.orderNumber,
        organizationId: order.organizationId,
        organizationName: order.organization.name,
        userCount: order.userCount,
        previousSeats: order.previousSeats,
        pricePerUserPaise: order.pricePerUserPaise,
        subtotalPaise: order.subtotalPaise,
        discountPaise: order.discountPaise,
        payablePaise: order.payablePaise,
        couponCode: order.couponCode,
        status: expired ? "EXPIRED" : order.status,
        confirmationCode: order.confirmationCode,
        transactionRef: order.transactionRef,
        payerNote: order.payerNote,
        hasIssuedCode: order.issuedCodeHash != null,
        createdAt: order.createdAt,
        submittedAt: order.submittedAt,
        reviewedAt: order.reviewedAt,
        expiresAt: order.expiresAt,
        minutesRemaining: minutesRemaining(toState(order), now),
      };
    }),
    total,
  };
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

async function loadOrder(orderId: string): Promise<PaymentOrder> {
  const order = await prisma.paymentOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError("That payment request");
  return order;
}

/**
 * Approve: credit the seats and record why.
 *
 * The crediting itself lives in `settleApproval`, because it now happens from
 * two places -- this button, and an organisation typing in the code that was
 * issued against the order. The guards stay here: this is the door for a
 * person pressing a button on the platform.
 */
export async function approveOrder(
  ctx: AuthContext,
  orderId: string,
  note?: string,
): Promise<PaymentOrder> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.approve");

  const order = await loadOrder(orderId);
  const pricing = await getPlatformPricing();
  return settleApproval(ctx, order, {
    actorUserId: ctx.userId,
    mode: pricing.confirmationMode,
    note,
    via: "button",
  });
}

export async function rejectOrder(
  ctx: AuthContext,
  orderId: string,
  note: string,
): Promise<PaymentOrder> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.approve");
  if (!note.trim()) throw new ValidationError("Give a reason so the organisation knows what to fix.");

  const order = await loadOrder(orderId);
  const pricing = await getPlatformPricing();
  const now = new Date();

  const result = transition(
    toState(order),
    { type: "REJECT", actorId: ctx.userId, note },
    { now, mode: pricing.confirmationMode },
  );
  if (!result.ok) throw new ConflictError(result.message ?? "This request cannot be rejected now.");

  // Onto the row that was read, or not at all: a reject decided on a stale
  // read must not turn an order approved a moment ago into REJECTED.
  const updated = await writeOrderIfUnchanged(order, {
    status: "REJECTED",
    reviewedAt: now,
    reviewedById: ctx.userId,
    reviewNote: note,
    issuedCodeHash: null,
    issuedCodeCipher: null,
  });
  if (!updated) throw new ConflictError(ORDER_CHANGED_MESSAGE);

  await prisma.paymentOrderEvent.create({
    data: {
      paymentOrderId: order.id,
      fromStatus: order.status,
      toStatus: "REJECTED",
      note,
      actorId: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payment.rejected",
    entityType: "PaymentOrder",
    entityId: order.id,
    organizationId: order.organizationId,
    after: { status: "REJECTED", note },
  });

  await notify.toOrgRoles(order.organizationId, ["ORG_OWNER", "ADMIN"], {
    type: "payment.rejected",
    title: "Payment could not be confirmed",
    body: note,
    link: "/billing",
  });

  return updated;
}

export async function requestMoreInfo(
  ctx: AuthContext,
  orderId: string,
  note: string,
): Promise<PaymentOrder> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.approve");
  if (!note.trim()) throw new ValidationError("Say what you need from the organisation.");

  const order = await loadOrder(orderId);
  const pricing = await getPlatformPricing();
  const now = new Date();

  const result = transition(
    toState(order),
    { type: "REQUEST_INFO", actorId: ctx.userId, note },
    { now, mode: pricing.confirmationMode },
  );
  if (!result.ok) throw new ConflictError(result.message ?? "That is not possible now.");

  // A stale "ask for more information" used to reopen an approved order, and
  // the organisation's next resubmission let it be approved -- and credited --
  // a second time.
  const updated = await writeOrderIfUnchanged(order, { status: "INFO_REQUESTED", infoRequestNote: note });
  if (!updated) throw new ConflictError(ORDER_CHANGED_MESSAGE);

  await prisma.paymentOrderEvent.create({
    data: {
      paymentOrderId: order.id,
      fromStatus: order.status,
      toStatus: "INFO_REQUESTED",
      note,
      actorId: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payment.info_requested",
    entityType: "PaymentOrder",
    entityId: order.id,
    organizationId: order.organizationId,
    after: { note },
  });

  await notify.toOrgRoles(order.organizationId, ["ORG_OWNER", "ADMIN"], {
    type: "payment.info_requested",
    title: "More information needed",
    body: note,
    link: "/billing",
  });

  return updated;
}

/**
 * Mode CODE: mint a confirmation code for the organisation to type in.
 *
 * The plaintext is returned exactly once, to this caller. What is stored is a
 * bcrypt hash (for verification) plus an encrypted copy (so the owner can read
 * back the code they issued) — never plaintext.
 */
export async function issueConfirmationCode(
  ctx: AuthContext,
  orderId: string,
): Promise<{ code: string; order: PaymentOrder }> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.approve");

  const order = await loadOrder(orderId);
  const pricing = await getPlatformPricing();
  const now = new Date();

  if (pricing.confirmationMode === "UTR") {
    throw new ConflictError(
      "Issued codes are switched off. Change the confirmation mode in platform settings first.",
    );
  }

  const result = transition(
    toState(order),
    { type: "ISSUE_CODE", actorId: ctx.userId },
    { now, mode: pricing.confirmationMode },
  );
  if (!result.ok) throw new ConflictError(result.message ?? "A code cannot be issued now.");

  const generated = await generateConfirmationCode();

  const updated = await writeOrderIfUnchanged(order, {
    issuedCodeHash: generated.hash,
    issuedCodeCipher: encryptField(generated.plaintext),
    codeIssuedAt: now,
    codeIssuedById: ctx.userId,
    codeAttemptCount: 0,
  });
  if (!updated) throw new ConflictError(ORDER_CHANGED_MESSAGE);

  await prisma.paymentOrderEvent.create({
    data: {
      paymentOrderId: order.id,
      fromStatus: order.status,
      toStatus: order.status,
      note: "Confirmation code issued",
      actorId: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payment.code_issued",
    entityType: "PaymentOrder",
    entityId: order.id,
    organizationId: order.organizationId,
    // The code itself is deliberately absent from the audit row.
    metadata: { orderNumber: order.orderNumber },
  });

  await notify.toOrgRoles(order.organizationId, ["ORG_OWNER", "ADMIN"], {
    type: "payment.code_issued",
    title: "Confirmation code ready",
    body: "Your payment confirmation code has been issued. Enter it on the billing page to activate your seats.",
    link: "/billing",
  });

  return { code: generated.plaintext, order: updated };
}

/** Lets the owner re-read a code they already issued, without minting a new one. */
export async function revealIssuedCode(ctx: AuthContext, orderId: string): Promise<string | null> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.approve");

  const order = await loadOrder(orderId);
  if (!order.issuedCodeCipher) return null;

  await writeAudit(ctx, {
    action: "payment.code_issued",
    entityType: "PaymentOrder",
    entityId: order.id,
    organizationId: order.organizationId,
    metadata: { revealed: true, orderNumber: order.orderNumber },
  });

  return decryptOptional(order.issuedCodeCipher);
}

export async function getOrderDetail(ctx: AuthContext, orderId: string) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.read");

  const order = await prisma.paymentOrder.findUnique({
    where: { id: orderId },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          slug: true,
          subscription: { select: { seats: true, currentPeriodEnd: true, billingMode: true } },
        },
      },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) throw new NotFoundError("That payment request");

  const now = new Date();
  return {
    ...withoutIssuedCode(order),
    expired: isExpired(toState(order), now),
    minutesRemaining: minutesRemaining(toState(order), now),
  };
}

/* -------------------------------------------------------------------------- */
/*  Codes made in advance                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A code the owner makes before there is an order.
 *
 * "Pay four thousand, your code is 481920." The organisation types it in at
 * checkout, where it takes its discount off and binds itself to the order, or
 * at confirmation, where it confirms payment and -- if it carries a discount
 * the order does not have yet -- re-prices the order first. Spent once. Every
 * order it confirms still goes through approval, because the money has not
 * been seen when the code is made; only the order-bound code skips that.
 */

export interface IssueAdvanceCodeInput {
  /** Null for a code any organisation may use. */
  organizationId?: string | null;
  /** 0-100. Null or 0 for a code that only confirms. */
  discountPercent?: number | null;
  maxDiscountPaise?: number | null;
  /** How long it stays usable. Thirty days when not said. */
  validDays?: number;
  note?: string | null;
}

export interface PaymentCodeRow {
  id: string;
  /** Order-bound codes are issued from the Payments row and listed here too. */
  kind: "ORDER" | "ADVANCE";
  organizationId: string | null;
  organizationName: string | null;
  orderId: string | null;
  orderNumber: string | null;
  discountPercent: number | null;
  maxDiscountPaise: number | null;
  note: string | null;
  issuedAt: Date;
  issuedById: string;
  issuedByName: string | null;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  /** Live: may still be typed in. Applied: priced into an order not yet confirmed. */
  state: "LIVE" | "APPLIED" | "USED" | "EXPIRED" | "REVOKED";
}

const ADVANCE_CODE_DEFAULT_DAYS = 30;

export async function issueAdvanceCode(
  ctx: AuthContext,
  input: IssueAdvanceCodeInput,
): Promise<{ code: string; id: string; expiresAt: Date }> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.approve");

  const percent = input.discountPercent ?? null;
  if (percent != null && (percent < 0 || percent > 100)) {
    throw new ValidationError("A discount is between 0 and 100 per cent.");
  }
  if (input.maxDiscountPaise != null && input.maxDiscountPaise < 0) {
    throw new ValidationError("A discount cap cannot be negative.");
  }
  const validDays = input.validDays ?? ADVANCE_CODE_DEFAULT_DAYS;
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) {
    throw new ValidationError("A code is valid for between 1 and 365 days.");
  }

  let organizationName: string | null = null;
  if (input.organizationId) {
    const org = await prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { name: true, status: true },
    });
    if (!org) throw new NotFoundError("That organisation");
    if (org.status === "ARCHIVED") {
      throw new ValidationError("That organisation is archived and cannot buy anything.");
    }
    organizationName = org.name;
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + validDays * 86_400_000);

  /**
   * Six digits, unique among the codes that could still be typed in.
   *
   * A million possibilities and a handful of live codes: a collision is rare
   * and cheap to avoid, and the alternative -- two live codes with the same
   * digits, one of them for a different organisation -- is the kind of thing
   * that gets reported as "the code did not work" with no way to see why.
   */
  let plaintext = "";
  let codeHash = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    plaintext = randomNumericCode(6);
    codeHash = sha256(plaintext);
    const clash = await prisma.paymentCode.findFirst({
      where: { codeHash, usedAt: null, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    if (!clash) break;
    plaintext = "";
  }
  if (!plaintext) throw new ConflictError("Could not find an unused code. Try again.");

  const row = await prisma.paymentCode.create({
    data: {
      codeHash,
      codeCipher: encryptField(plaintext),
      organizationId: input.organizationId ?? null,
      discountPercent: percent && percent > 0 ? percent : null,
      maxDiscountPaise: percent && percent > 0 ? (input.maxDiscountPaise ?? null) : null,
      expiresAt,
      note: input.note?.trim() || null,
      issuedById: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payment.advance_code_issued",
    entityType: "PaymentCode",
    entityId: row.id,
    organizationId: input.organizationId ?? null,
    // The code itself is deliberately absent from the audit row.
    metadata: {
      organizationName,
      discountPercent: row.discountPercent ? Number(row.discountPercent) : null,
      maxDiscountPaise: row.maxDiscountPaise,
      expiresAt,
      note: row.note,
    },
  });

  if (input.organizationId) {
    await notify.toOrgRoles(input.organizationId, ["ORG_OWNER", "ADMIN"], {
      type: "payment.code_issued",
      title: "A payment code is ready for you",
      body: "Broadmate has issued you a payment code. Enter it while buying seats, or when confirming a payment.",
      link: "/billing",
    });
  }

  return { code: plaintext, id: row.id, expiresAt };
}

/** The owner re-reading a code they already handed out. Audited every time. */
export async function revealAdvanceCode(ctx: AuthContext, id: string): Promise<string> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.approve");

  const row = await prisma.paymentCode.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("That payment code");

  await writeAudit(ctx, {
    action: "payment.advance_code_revealed",
    entityType: "PaymentCode",
    entityId: row.id,
    organizationId: row.organizationId,
  });

  return decryptOptional(row.codeCipher) ?? "";
}

/**
 * Withdraw a code that has not been used.
 *
 * One applied at checkout is still withdrawable: the order it priced keeps its
 * price -- the owner chose the discount and the organisation has seen the QR
 * -- but the code will no longer confirm it, so a reference is needed instead.
 */
export async function revokeAdvanceCode(ctx: AuthContext, id: string): Promise<PaymentCodeRow> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.approve");

  const row = await prisma.paymentCode.findUnique({ where: { id } });
  if (!row) throw new NotFoundError("That payment code");
  if (row.usedAt) throw new ConflictError("That code has already been used, so there is nothing to withdraw.");
  if (row.revokedAt) throw new ConflictError("That code was already withdrawn.");

  const updated = await prisma.paymentCode.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  await writeAudit(ctx, {
    action: "payment.advance_code_revoked",
    entityType: "PaymentCode",
    entityId: row.id,
    organizationId: row.organizationId,
    metadata: { note: row.note, hadBeenApplied: row.appliedAt != null },
  });

  const [full] = await listPaymentCodes(ctx, { ids: [updated.id] });
  return full as PaymentCodeRow;
}

function stateOf(
  row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date; appliedAt: Date | null },
  now: Date,
): PaymentCodeRow["state"] {
  if (row.usedAt) return "USED";
  if (row.revokedAt) return "REVOKED";
  if (row.expiresAt <= now) return "EXPIRED";
  if (row.appliedAt) return "APPLIED";
  return "LIVE";
}

/**
 * Every code that exists, both kinds, newest first.
 *
 * Order-bound codes live on the order row and advance codes in their own
 * table; the owner should not have to know which is which to find "the code
 * I gave Jivonik on Tuesday". So both are read and put in one list with one
 * shape, and `kind` says where it came from.
 */
export async function listPaymentCodes(
  ctx: AuthContext,
  filters: { state?: "live" | "used" | "all"; ids?: string[]; take?: number } = {},
): Promise<PaymentCodeRow[]> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.payment.read");

  const now = new Date();
  const take = filters.take ?? 200;

  const [advance, bound] = await Promise.all([
    prisma.paymentCode.findMany({
      where: filters.ids ? { id: { in: filters.ids } } : undefined,
      orderBy: { issuedAt: "desc" },
      take,
      include: {
        organization: { select: { name: true } },
        order: { select: { id: true, orderNumber: true, organizationId: true, organization: { select: { name: true } } } },
      },
    }),
    filters.ids
      ? []
      : prisma.paymentOrder.findMany({
          where: { codeIssuedAt: { not: null } },
          orderBy: { codeIssuedAt: "desc" },
          take,
          select: {
            id: true,
            orderNumber: true,
            organizationId: true,
            organization: { select: { name: true } },
            codeIssuedAt: true,
            codeIssuedById: true,
            issuedCodeHash: true,
            expiresAt: true,
            status: true,
            submittedAt: true,
            reviewedAt: true,
          },
        }),
  ]);

  const issuerIds = new Set<string>();
  for (const row of advance) issuerIds.add(row.issuedById);
  for (const row of bound) if (row.codeIssuedById) issuerIds.add(row.codeIssuedById);
  const issuers = issuerIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...issuerIds] } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const issuerName = (id: string | null) => {
    if (!id) return null;
    const user = issuers.find((u) => u.id === id);
    return user ? (user.name ?? user.email) : null;
  };

  const rows: PaymentCodeRow[] = [
    ...advance.map((row) => ({
      id: row.id,
      kind: "ADVANCE" as const,
      organizationId: row.organizationId ?? row.order?.organizationId ?? null,
      organizationName: row.organization?.name ?? row.order?.organization.name ?? null,
      orderId: row.order?.id ?? null,
      orderNumber: row.order?.orderNumber ?? null,
      discountPercent: row.discountPercent == null ? null : Number(row.discountPercent),
      maxDiscountPaise: row.maxDiscountPaise,
      note: row.note,
      issuedAt: row.issuedAt,
      issuedById: row.issuedById,
      issuedByName: issuerName(row.issuedById),
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      revokedAt: row.revokedAt,
      state: stateOf(row, now),
    })),
    ...bound.map((order) => {
      // An order-bound code is spent when the order moves past INITIATED with
      // it, and dead with the order: approval clears the hash, and an expired
      // or rejected order cannot be confirmed any more. The window only closes
      // an order nobody confirmed (`clockRunning`); a code issued against an
      // order that is waiting on review stays live however old the order is.
      const consumed = order.issuedCodeHash == null && order.status !== "INITIATED";
      const closed =
        ["REJECTED", "EXPIRED"].includes(order.status) ||
        (clockRunning(order.status) && order.expiresAt <= now);
      return {
        id: `order:${order.id}`,
        kind: "ORDER" as const,
        organizationId: order.organizationId,
        organizationName: order.organization.name,
        orderId: order.id,
        orderNumber: order.orderNumber,
        discountPercent: null,
        maxDiscountPaise: null,
        note: null,
        issuedAt: order.codeIssuedAt as Date,
        issuedById: order.codeIssuedById ?? "",
        issuedByName: issuerName(order.codeIssuedById),
        expiresAt: order.expiresAt,
        usedAt: consumed ? (order.reviewedAt ?? order.submittedAt) : null,
        revokedAt: null,
        state: (consumed ? "USED" : closed ? "EXPIRED" : "LIVE") as PaymentCodeRow["state"],
      };
    }),
  ];

  rows.sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());

  const state = filters.state ?? "all";
  return rows.filter((row) =>
    state === "live"
      ? row.state === "LIVE" || row.state === "APPLIED"
      : state === "used"
        ? row.state === "USED"
        : true,
  );
}
