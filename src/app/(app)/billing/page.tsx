import Link from "next/link";
import { CreditCard, Users } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listOrdersForOrg } from "@/services/billing/orders";
import { prisma } from "@/lib/db/prisma";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDate, formatMoney, formatRelative } from "@/lib/utils";
import { resolveAccessState, summariseSeats } from "@/domain/billing/seats";
import { SeatPurchase } from "./SeatPurchase";

export const metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  APPROVED: "success",
  AWAITING_CONFIRMATION: "warning",
  INFO_REQUESTED: "info",
  INITIATED: "primary",
  REJECTED: "danger",
  EXPIRED: "neutral",
} as const;

export default async function BillingPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "org.billing.manage", what: "billing" });
  if (denied) return denied;

  const [orders, subscription] = await Promise.all([
    listOrdersForOrg(ctx),
    prisma.subscription.findUnique({ where: { organizationId: ctx.organizationId! } }),
  ]);

  const seats = summariseSeats(
    subscription?.seats ?? 0,
    ctx.organization?.activeEmployees ?? 0,
  );
  const access = subscription
    ? resolveAccessState(
        {
          billingMode: subscription.billingMode,
          currentPeriodEnd: subscription.currentPeriodEnd,
          trialEndsAt: subscription.trialEndsAt,
          status: subscription.status,
        },
        new Date(),
      )
    : "TRIAL_EXPIRED";
  // Past due because the platform said so, not because a date passed: a paid
  // organisation created without "already paid", or one the owner switched
  // off. Its period end is a cycle away and means nothing until a payment is
  // approved, so it is not shown as a renewal date.
  const awaitingFirstPayment = access === "PAST_DUE" && subscription?.status === "PAST_DUE";

  // An order still open is what the owner should act on first. One that has
  // been confirmed waits for the platform and stays open however long that
  // takes, so it stays at the top too.
  const live = orders.find((o) =>
    ["INITIATED", "AWAITING_CONFIRMATION", "INFO_REQUESTED"].includes(o.status),
  );

  return (
    <>
      <PageHeader
        title="Billing & seats"
        description="Seats are counted from your active employees. People who have left do not use one."
      />

      {access === "TRIAL_EXPIRED" ? (
        <div className="mb-4">
          <Alert tone="danger" title="Your trial has ended">
            The app is read-only until seats are purchased and payment is confirmed.
          </Alert>
        </div>
      ) : awaitingFirstPayment ? (
        <div className="mb-4">
          <Alert tone="danger" title="Payment is due">
            The app is read-only until seats are purchased below and the payment is approved
            by the platform team.
          </Alert>
        </div>
      ) : access === "PAST_DUE" ? (
        <div className="mb-4">
          <Alert tone="danger" title="Your subscription has lapsed">
            Renew below to restore full access.
          </Alert>
        </div>
      ) : access === "TRIAL" && subscription?.trialEndsAt ? (
        <div className="mb-4">
          <Alert tone="info" title="You are on a trial">
            It runs until {formatDate(subscription.trialEndsAt)}. Buy seats before then to keep
            working without interruption.
          </Alert>
        </div>
      ) : null}

      <StatGrid>
        <Stat
          label={awaitingFirstPayment ? "Seats allotted" : "Seats purchased"}
          value={seats.seats}
          hint={
            awaitingFirstPayment
              ? "awaiting payment"
              : subscription
                ? subscription.billingMode.replace("_", " ").toLowerCase()
                : undefined
          }
          icon={CreditCard}
          tone="primary"
        />
        <Stat
          label="Seats in use"
          value={seats.used}
          hint={`${seats.utilisationPercent}% utilised`}
          icon={Users}
          tone={seats.remaining === 0 ? "danger" : "neutral"}
        />
        <Stat
          label="Seats available"
          value={seats.remaining}
          icon={Users}
          tone={seats.remaining === 0 ? "danger" : "success"}
        />
        <Stat
          label="Renews on"
          value={
            awaitingFirstPayment || !subscription ? "—" : formatDate(subscription.currentPeriodEnd)
          }
          hint={awaitingFirstPayment ? "set once payment is approved" : undefined}
          icon={CreditCard}
        />
      </StatGrid>

      {live ? (
        <div className="mt-4">
          <Alert tone="warning" title="You have a payment in progress">
            {live.orderNumber} for {live.userCount} seats ·{" "}
            <Link href={`/billing/${live.id}`} className="underline underline-offset-2">
              Continue
            </Link>
          </Alert>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,420px)_1fr] lg:items-start">
        <SeatPurchase
          currentSeats={seats.seats}
          activeEmployees={ctx.organization?.activeEmployees ?? 0}
        />

        <Section
          title="Payment history"
          description="Every request, including the ones that expired."
        >
          <ResponsiveList
            items={orders}
            empty={
              <EmptyState
                icon={CreditCard}
                title="No payments yet"
                description="Buy seats to get started."
              />
            }
            head={
              <>
                <TH>Order</TH>
                <TH>Seats</TH>
                <TH numeric>Amount</TH>
                <TH>Status</TH>
                <TH>Raised</TH>
              </>
            }
            row={(order) => (
              <TR key={order.id}>
                <TD>
                  <Link href={`/billing/${order.id}`} className="font-mono text-xs hover:underline">
                    {order.orderNumber}
                  </Link>
                </TD>
                <TD className="tabular">{order.userCount}</TD>
                <TD numeric>
                  {formatMoney(order.payablePaise)}
                  {order.discountPaise > 0 ? (
                    <span className="block text-xs text-success-text">
                      −{formatMoney(order.discountPaise)} {order.couponCode}
                    </span>
                  ) : null}
                </TD>
                <TD>
                  <Badge tone={STATUS_TONE[order.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                    {order.status.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                </TD>
                <TD className="text-xs text-muted-foreground">{formatRelative(order.createdAt)}</TD>
              </TR>
            )}
            card={(order) => (
              <Link key={order.id} href={`/billing/${order.id}`} className="block">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-xs text-muted-foreground">{order.orderNumber}</p>
                    <p className="tabular mt-0.5 text-sm font-medium">
                      {formatMoney(order.payablePaise)}
                    </p>
                  </div>
                  <Badge tone={STATUS_TONE[order.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                    {order.status.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {order.userCount} seats · {formatRelative(order.createdAt)}
                </p>
              </Link>
            )}
          />
        </Section>
      </div>
    </>
  );
}
