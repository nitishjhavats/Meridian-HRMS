import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { averageRevenuePerOrg, computeMrr } from "@/domain/billing/pricing";
import { MONTH_NAMES } from "@/domain/date";

/**
 * Revenue analytics.
 *
 * Everything is derived from **historical rows** — approved `PaymentOrder`s and
 * `SubscriptionHistory` — not from current subscription state. Current state
 * tells you what someone pays today; it cannot tell you what they paid in March,
 * which is exactly what this screen is for.
 */

export interface RevenueFilters {
  year?: number;
  month?: number;
  organizationId?: string;
  status?: string[];
  couponCode?: string;
  minUserCount?: number;
  maxUserCount?: number;
  from?: Date;
  to?: Date;
}

export interface RevenueSummary {
  mrrPaise: number;
  collectedPaise: number;
  pendingPaise: number;
  discountGivenPaise: number;
  paidSeats: number;
  payingOrganisations: number;
  activeOrganisations: number;
  averageRevenuePerOrgPaise: number;
  orderCount: number;
}

export interface MonthlyPoint {
  year: number;
  month: number;
  label: string;
  collectedPaise: number;
  discountPaise: number;
  orders: number;
  seats: number;
}

export interface OrganizationRevenueRow {
  organizationId: string;
  organizationName: string;
  orders: number;
  seatsPaidFor: number;
  collectedPaise: number;
  discountPaise: number;
  lastPaymentAt: Date | null;
}

export interface PaymentHistoryRow {
  id: string;
  orderNumber: string;
  organizationName: string;
  createdAt: Date;
  reviewedAt: Date | null;
  userCount: number;
  previousSeats: number;
  pricePerUserPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  payablePaise: number;
  couponCode: string | null;
  status: string;
  confirmationCode: string | null;
  transactionRef: string | null;
  periodMonths: number;
}

function whereFrom(filters: RevenueFilters) {
  const range: { gte?: Date; lte?: Date } = {};
  if (filters.year != null) {
    const startMonth = filters.month != null ? filters.month - 1 : 0;
    const endMonth = filters.month != null ? filters.month : 12;
    range.gte = new Date(Date.UTC(filters.year, startMonth, 1));
    range.lte = new Date(Date.UTC(filters.year, endMonth, 1));
  }
  if (filters.from) range.gte = filters.from;
  if (filters.to) range.lte = filters.to;

  return {
    ...(Object.keys(range).length > 0 ? { createdAt: range } : {}),
    ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
    ...(filters.couponCode ? { couponCode: filters.couponCode.toUpperCase() } : {}),
    ...(filters.status?.length ? { status: { in: filters.status as never } } : {}),
    ...(filters.minUserCount != null || filters.maxUserCount != null
      ? {
          userCount: {
            ...(filters.minUserCount != null ? { gte: filters.minUserCount } : {}),
            ...(filters.maxUserCount != null ? { lte: filters.maxUserCount } : {}),
          },
        }
      : {}),
  };
}

export async function getRevenueSummary(
  ctx: AuthContext,
  filters: RevenueFilters = {},
): Promise<RevenueSummary> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.analytics.read");

  const base = whereFrom(filters);

  const [approved, pending, subscriptions, activeOrgs] = await Promise.all([
    prisma.paymentOrder.aggregate({
      where: { ...base, status: "APPROVED" },
      _sum: { payablePaise: true, userCount: true, discountPaise: true },
      _count: { _all: true },
    }),
    prisma.paymentOrder.aggregate({
      where: { ...base, status: { in: ["AWAITING_CONFIRMATION", "INFO_REQUESTED", "INITIATED"] } },
      _sum: { payablePaise: true },
    }),
    prisma.subscription.findMany({
      select: { seats: true, pricePerUserPaise: true, billingMode: true, organizationId: true },
    }),
    prisma.organization.count({ where: { status: "ACTIVE" } }),
  ]);

  const paying = subscriptions.filter((s) => s.billingMode === "PAID");
  const collected = approved._sum.payablePaise ?? 0;

  return {
    mrrPaise: computeMrr(subscriptions),
    collectedPaise: collected,
    pendingPaise: pending._sum.payablePaise ?? 0,
    discountGivenPaise: approved._sum.discountPaise ?? 0,
    paidSeats: approved._sum.userCount ?? 0,
    payingOrganisations: paying.length,
    activeOrganisations: activeOrgs,
    averageRevenuePerOrgPaise: averageRevenuePerOrg(collected, paying.length),
    orderCount: approved._count._all,
  };
}

/** Collections by calendar month, for the revenue chart. */
export async function getMonthlyRevenue(
  ctx: AuthContext,
  filters: RevenueFilters = {},
  months = 12,
): Promise<MonthlyPoint[]> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.analytics.read");

  const orders = await prisma.paymentOrder.findMany({
    where: { ...whereFrom(filters), status: "APPROVED" },
    select: {
      reviewedAt: true,
      createdAt: true,
      payablePaise: true,
      discountPaise: true,
      userCount: true,
    },
  });

  // Revenue is recognised when the payment was *approved*, not when the order
  // was raised — an order created in March and approved in April is April money.
  const buckets = new Map<string, MonthlyPoint>();
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    buckets.set(`${year}-${month}`, {
      year,
      month,
      label: `${MONTH_NAMES[month - 1]?.slice(0, 3)} ${String(year).slice(2)}`,
      collectedPaise: 0,
      discountPaise: 0,
      orders: 0,
      seats: 0,
    });
  }

  for (const order of orders) {
    const at = order.reviewedAt ?? order.createdAt;
    const key = `${at.getUTCFullYear()}-${at.getUTCMonth() + 1}`;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.collectedPaise += order.payablePaise;
    bucket.discountPaise += order.discountPaise;
    bucket.orders += 1;
    bucket.seats += order.userCount;
  }

  return [...buckets.values()];
}

export async function getRevenueByOrganization(
  ctx: AuthContext,
  filters: RevenueFilters = {},
): Promise<OrganizationRevenueRow[]> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.analytics.read");

  const grouped = await prisma.paymentOrder.groupBy({
    by: ["organizationId"],
    where: { ...whereFrom(filters), status: "APPROVED" },
    _sum: { payablePaise: true, userCount: true, discountPaise: true },
    _count: { _all: true },
    _max: { reviewedAt: true },
  });

  const organizations = await prisma.organization.findMany({
    where: { id: { in: grouped.map((g) => g.organizationId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(organizations.map((o) => [o.id, o.name]));

  return grouped
    .map((row) => ({
      organizationId: row.organizationId,
      organizationName: nameById.get(row.organizationId) ?? "Unknown",
      orders: row._count._all,
      seatsPaidFor: row._sum.userCount ?? 0,
      collectedPaise: row._sum.payablePaise ?? 0,
      discountPaise: row._sum.discountPaise ?? 0,
      lastPaymentAt: row._max.reviewedAt,
    }))
    .sort((a, b) => b.collectedPaise - a.collectedPaise);
}

export async function getPaymentHistory(
  ctx: AuthContext,
  filters: RevenueFilters = {},
  take = 200,
): Promise<PaymentHistoryRow[]> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.analytics.read");

  const orders = await prisma.paymentOrder.findMany({
    where: whereFrom(filters),
    orderBy: { createdAt: "desc" },
    take,
    include: { organization: { select: { name: true } } },
  });

  return orders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    organizationName: o.organization.name,
    createdAt: o.createdAt,
    reviewedAt: o.reviewedAt,
    userCount: o.userCount,
    previousSeats: o.previousSeats,
    pricePerUserPaise: o.pricePerUserPaise,
    subtotalPaise: o.subtotalPaise,
    discountPaise: o.discountPaise,
    payablePaise: o.payablePaise,
    couponCode: o.couponCode,
    status: o.status,
    confirmationCode: o.confirmationCode,
    transactionRef: o.transactionRef,
    periodMonths: o.periodMonths,
  }));
}

/** Rows for the CSV export. Returned as arrays so the handler just joins them. */
export function paymentHistoryToCsv(rows: PaymentHistoryRow[]): (string | number | null)[][] {
  const rupees = (paise: number) => (paise / 100).toFixed(2);
  return [
    [
      "Order number",
      "Organisation",
      "Raised on",
      "Approved on",
      "Users",
      "Previous seats",
      "Price per user",
      "Subtotal",
      "Discount",
      "Coupon",
      "Payable",
      "Status",
      "Confirmation code",
      "Transaction reference",
      "Period (months)",
    ],
    ...rows.map((r) => [
      r.orderNumber,
      r.organizationName,
      r.createdAt.toISOString().slice(0, 10),
      r.reviewedAt?.toISOString().slice(0, 10) ?? "",
      r.userCount,
      r.previousSeats,
      rupees(r.pricePerUserPaise),
      rupees(r.subtotalPaise),
      rupees(r.discountPaise),
      r.couponCode ?? "",
      rupees(r.payablePaise),
      r.status,
      r.confirmationCode ?? "",
      r.transactionRef ?? "",
      r.periodMonths,
    ]),
  ];
}
