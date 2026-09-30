import Link from "next/link";
import { Clock, CreditCard } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { listOrders } from "@/services/platform/payments";
import { getPlatformPricing } from "@/services/billing/orders";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatMoney, formatRelative, pluralise } from "@/lib/utils";
import { PaymentActions } from "./PaymentActions";
import { OrderTimeline } from "./OrderTimeline";

export const metadata = { title: "Payments" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  APPROVED: "success",
  AWAITING_CONFIRMATION: "warning",
  INFO_REQUESTED: "info",
  INITIATED: "neutral",
  REJECTED: "danger",
  EXPIRED: "neutral",
} as const;

const TABS = [
  { key: "review", label: "Needs review", statuses: ["AWAITING_CONFIRMATION", "INFO_REQUESTED"] },
  { key: "open", label: "Awaiting payment", statuses: ["INITIATED"] },
  { key: "approved", label: "Approved", statuses: ["APPROVED"] },
  { key: "closed", label: "Rejected & expired", statuses: ["REJECTED", "EXPIRED"] },
  { key: "all", label: "All", statuses: [] },
] as const;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  const ctx = await requirePageContext({ superadmin: true });
  const params = await searchParams;
  const tab = TABS.find((t) => t.key === params.tab) ?? TABS[0];

  const [{ rows, total }, pricing] = await Promise.all([
    listOrders(ctx, {
      status: tab.statuses.length ? (tab.statuses as never) : undefined,
      search: params.q,
      take: 100,
    }),
    getPlatformPricing(),
  ]);

  return (
    <>
      <PageHeader
        title="Payments"
        description={`${pluralise(total, "request")} · confirmation mode: ${
          pricing.confirmationMode === "BOTH"
            ? "reference or issued code"
            : pricing.confirmationMode === "UTR"
              ? "organisation submits a reference"
              : "you issue a code"
        }`}
      />

      <nav className="no-scrollbar mb-4 flex gap-1 overflow-x-auto" aria-label="Filter by status">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/platform/payments?tab=${t.key}`}
            className={`shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors ${
              t.key === tab.key
                ? "bg-primary-muted font-medium text-primary"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <Section
        title={tab.label}
        description="The 4-hour confirmation window is enforced when you act, not just when this page loaded."
      >
        <ResponsiveList
          items={rows}
          empty={
            <EmptyState
              icon={CreditCard}
              title="Nothing here"
              description="Payment requests appear as organisations submit them."
            />
          }
          head={
            <>
              <TH>Order</TH>
              <TH>Organisation</TH>
              <TH>Seats</TH>
              <TH numeric>Amount</TH>
              <TH>Reference</TH>
              <TH>Status</TH>
              <TH>Window</TH>
              <TH>Actions</TH>
            </>
          }
          row={(order) => (
            <TR key={order.id}>
              <TD className="font-mono text-xs">{order.orderNumber}</TD>
              <TD>
                <Link
                  href={`/platform/organisations/${order.organizationId}`}
                  className="hover:underline"
                >
                  {order.organizationName}
                </Link>
              </TD>
              <TD>
                <span className="tabular">{order.userCount}</span>
                {order.previousSeats > 0 ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    from {order.previousSeats}
                  </span>
                ) : null}
              </TD>
              <TD numeric>
                {formatMoney(order.payablePaise)}
                {order.discountPaise > 0 ? (
                  <span className="block text-xs text-success-text">
                    −{formatMoney(order.discountPaise)} {order.couponCode}
                  </span>
                ) : null}
              </TD>
              <TD className="font-mono text-xs">{order.transactionRef ?? "—"}</TD>
              <TD>
                <Badge tone={STATUS_TONE[order.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                  {order.status.replaceAll("_", " ").toLowerCase()}
                </Badge>
              </TD>
              <TD className="text-xs text-muted-foreground">
                {!Number.isFinite(order.minutesRemaining) ? (
                  // Confirmed: the clock stopped when the organisation said
                  // "paid", and the request waits for this queue, not the other
                  // way round.
                  "with you"
                ) : order.minutesRemaining > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3" aria-hidden />
                    {formatWindow(order.minutesRemaining)}
                  </span>
                ) : (
                  "closed"
                )}
              </TD>
              <TD>
                <span className="flex items-center gap-1">
                  <PaymentActions order={order} confirmationMode={pricing.confirmationMode} />
                  <OrderTimeline orderId={order.id} orderNumber={order.orderNumber} />
                </span>
              </TD>
            </TR>
          )}
          card={(order) => (
            <div key={order.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{order.organizationName}</p>
                  <p className="font-mono text-xs text-muted-foreground">{order.orderNumber}</p>
                </div>
                <Badge tone={STATUS_TONE[order.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                  {order.status.replaceAll("_", " ").toLowerCase()}
                </Badge>
              </div>

              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div>
                  <dt className="text-muted-foreground">Seats</dt>
                  <dd className="tabular">
                    {order.userCount}
                    {order.previousSeats > 0 ? ` (from ${order.previousSeats})` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Amount</dt>
                  <dd className="tabular font-medium">{formatMoney(order.payablePaise)}</dd>
                </div>
                {order.transactionRef ? (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Reference</dt>
                    <dd className="font-mono">{order.transactionRef}</dd>
                  </div>
                ) : null}
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Window</dt>
                  <dd>
                    {!Number.isFinite(order.minutesRemaining)
                      ? `with you · raised ${formatRelative(order.createdAt)}`
                      : order.minutesRemaining > 0
                        ? `${formatWindow(order.minutesRemaining)} left`
                        : `closed · raised ${formatRelative(order.createdAt)}`}
                  </dd>
                </div>
              </dl>

              <div className="mt-3">
                <PaymentActions order={order} confirmationMode={pricing.confirmationMode} />
              </div>
            </div>
          )}
        />
      </Section>
    </>
  );
}

function formatWindow(minutes: number): string {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }
  return `${minutes}m`;
}
