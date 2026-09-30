import Link from "next/link";
import { Download, TrendingUp, Users, Wallet } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import {
  getMonthlyRevenue,
  getPaymentHistory,
  getRevenueByOrganization,
  getRevenueSummary,
} from "@/services/platform/analytics";
import { listOrganizations } from "@/services/platform/organizations";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDate, formatMoney, formatMoneyCompact, pluralise } from "@/lib/utils";
import { MONTH_NAMES } from "@/domain/date";
import { RevenueChart } from "./RevenueChart";

export const metadata = { title: "Revenue" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  APPROVED: "success",
  AWAITING_CONFIRMATION: "warning",
  INFO_REQUESTED: "info",
  INITIATED: "neutral",
  REJECTED: "danger",
  EXPIRED: "neutral",
} as const;

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string; org?: string; coupon?: string }>;
}) {
  const ctx = await requirePageContext({ superadmin: true });
  const params = await searchParams;

  const thisYear = new Date().getFullYear();
  const month = params.month ? Number(params.month) : undefined;
  // A month on its own is a month of this year. `whereFrom` in the analytics
  // service builds its range from the year and ignores a month without one, so
  // "March" with "All years" used to show all-time totals under a filter the
  // form said was applied -- and the CSV carried the same lie. The year is
  // settled here so the form, the figures and the export all agree on it.
  const year = params.year ? Number(params.year) : month != null ? thisYear : undefined;

  const filters = {
    year,
    month,
    organizationId: params.org || undefined,
    couponCode: params.coupon || undefined,
  };

  const [summary, monthly, byOrg, history, organizations] = await Promise.all([
    getRevenueSummary(ctx, filters),
    getMonthlyRevenue(ctx, {}, 12),
    getRevenueByOrganization(ctx, filters),
    getPaymentHistory(ctx, filters, 100),
    listOrganizations(ctx),
  ]);

  const years = [thisYear, thisYear - 1, thisYear - 2];
  const exportQuery = new URLSearchParams(
    Object.entries(filters).flatMap(([k, v]) => (v != null ? [[k === "organizationId" ? "organizationId" : k, String(v)]] : [])),
  ).toString();

  return (
    <>
      <PageHeader
        title="Revenue"
        description="Built from historical payment records, so past months never change when a subscription does."
        action={
          <Button asChild variant="outline">
            <a href={`/api/platform/revenue/export?${exportQuery}`}>
              <Download className="size-4" aria-hidden />
              Export CSV
            </a>
          </Button>
        }
      />

      {/* ---------- filters, one row above the charts ---------- */}
      <form className="mb-4 flex flex-wrap items-end gap-2" method="get">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Year</span>
          <select
            name="year"
            // The settled year, not the raw parameter, so a month picked under
            // "All years" shows the year it was actually filtered to.
            defaultValue={year != null ? String(year) : ""}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
          >
            <option value="">All years</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Month</span>
          <select
            name="month"
            defaultValue={params.month ?? ""}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
          >
            <option value="">All months</option>
            {MONTH_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">Organisation</span>
          <select
            name="org"
            defaultValue={params.org ?? ""}
            className="h-9 rounded-md border border-input bg-card px-2 text-sm"
          >
            <option value="">All organisations</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>

        <Button type="submit" variant="outline" size="md">
          Apply
        </Button>
        {params.year || params.month || params.org ? (
          <Button asChild variant="ghost" size="md">
            <Link href="/platform/revenue">Clear</Link>
          </Button>
        ) : null}
      </form>

      <StatGrid>
        <Stat
          label="Monthly recurring revenue"
          value={formatMoneyCompact(summary.mrrPaise)}
          hint={`${pluralise(summary.payingOrganisations, "paying organisation")}`}
          icon={TrendingUp}
          tone="success"
        />
        <Stat
          label="Collected"
          value={formatMoneyCompact(summary.collectedPaise)}
          hint={`${pluralise(summary.orderCount, "approved payment")}`}
          icon={Wallet}
          tone="primary"
        />
        <Stat
          label="Pending"
          value={formatMoneyCompact(summary.pendingPaise)}
          hint="awaiting confirmation"
          icon={Wallet}
          tone={summary.pendingPaise > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Average per organisation"
          value={formatMoneyCompact(summary.averageRevenuePerOrgPaise)}
          hint={`${summary.paidSeats} seats paid for`}
          icon={Users}
        />
      </StatGrid>

      <div className="mt-4">
        <Section title="Trend">
          <RevenueChart data={monthly} />
        </Section>
      </div>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2 lg:items-start">
        <Section
          title="By organisation"
          description={
            summary.discountGivenPaise > 0
              ? `${formatMoney(summary.discountGivenPaise)} given away in discounts`
              : "No discounts given in this period"
          }
        >
          <ResponsiveList
            items={byOrg}
            empty={<EmptyState icon={Wallet} title="No approved payments in this period" />}
            head={
              <>
                <TH>Organisation</TH>
                <TH numeric>Collected</TH>
                <TH numeric>Seats</TH>
                <TH>Last payment</TH>
              </>
            }
            row={(row) => (
              <TR key={row.organizationId}>
                <TD>
                  <Link
                    href={`/platform/organisations/${row.organizationId}`}
                    className="hover:underline"
                  >
                    {row.organizationName}
                  </Link>
                  {row.discountPaise > 0 ? (
                    <span className="block text-xs text-success-text">
                      −{formatMoney(row.discountPaise)} discount
                    </span>
                  ) : null}
                </TD>
                <TD numeric>{formatMoney(row.collectedPaise)}</TD>
                <TD numeric>{row.seatsPaidFor}</TD>
                <TD className="text-xs text-muted-foreground">
                  {row.lastPaymentAt ? formatDate(row.lastPaymentAt) : "—"}
                </TD>
              </TR>
            )}
            card={(row) => (
              <div key={row.organizationId}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-sm font-medium">{row.organizationName}</p>
                  <p className="tabular text-sm">{formatMoney(row.collectedPaise)}</p>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {pluralise(row.orders, "payment")} · {row.seatsPaidFor} seats
                </p>
              </div>
            )}
          />
        </Section>

        <Section title="Payment history" description="Every request in the selected period.">
          <ResponsiveList
            items={history}
            empty={<EmptyState icon={Wallet} title="No payments in this period" />}
            head={
              <>
                <TH>Order</TH>
                <TH>Organisation</TH>
                <TH numeric>Amount</TH>
                <TH>Status</TH>
              </>
            }
            row={(row) => (
              <TR key={row.id}>
                <TD className="font-mono text-xs">
                  {row.orderNumber}
                  <span className="block text-muted-foreground">{formatDate(row.createdAt)}</span>
                </TD>
                <TD className="text-sm">{row.organizationName}</TD>
                <TD numeric>
                  {formatMoney(row.payablePaise)}
                  {row.couponCode ? (
                    <span className="block text-xs text-success-text">{row.couponCode}</span>
                  ) : null}
                </TD>
                <TD>
                  <Badge tone={STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                    {row.status.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                </TD>
              </TR>
            )}
            card={(row) => (
              <div key={row.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{row.organizationName}</p>
                    <p className="font-mono text-xs text-muted-foreground">{row.orderNumber}</p>
                  </div>
                  <Badge tone={STATUS_TONE[row.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                    {row.status.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                </div>
                <p className="tabular mt-1 text-sm font-medium">{formatMoney(row.payablePaise)}</p>
              </div>
            )}
          />
        </Section>
      </div>
    </>
  );
}
