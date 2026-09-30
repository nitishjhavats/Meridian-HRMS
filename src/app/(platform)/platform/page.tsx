import Link from "next/link";
import {
  AlertTriangle,
  Building2,
  CreditCard,
  KeyRound,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { requireSuperadmin } from "@/lib/auth/guard";
import { getPlatformDashboard } from "@/services/dashboard";
import { listOrganizationsPage } from "@/services/platform/organizations";
import { OrganisationsCard } from "./OrganisationsCard";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { formatMoney, formatMoneyCompact, formatRelative, pluralise } from "@/lib/utils";

export const metadata = { title: "Platform" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  APPROVED: "success",
  AWAITING_CONFIRMATION: "warning",
  INFO_REQUESTED: "info",
  INITIATED: "neutral",
  REJECTED: "danger",
  EXPIRED: "neutral",
} as const;

export default async function PlatformDashboardPage() {
  const ctx = await requirePageContext({ superadmin: true });
  requireSuperadmin(ctx);

  const data = await getPlatformDashboard();
  const queueTotal = data.queues.pendingPayments + data.queues.passwordResets;

  // Rendered on the server for the first page so the card is not empty for a
  // beat; the control takes over from there.
  const organisations = await listOrganizationsPage(ctx, { page: 1, pageSize: 10 });

  return (
    <>
      <PageHeader
        title="Platform overview"
        description="Every organisation, subscription and payment on this deployment."
      />

      <StatGrid>
        <Stat
          label="Monthly recurring revenue"
          value={formatMoneyCompact(data.revenue.mrrPaise)}
          hint={`${pluralise(data.revenue.paidSeats, "paid seat")}`}
          icon={TrendingUp}
          tone="success"
          href="/platform/revenue"
        />
        <Stat
          label="Collected to date"
          value={formatMoneyCompact(data.revenue.collectedPaise)}
          icon={Wallet}
          tone="primary"
          href="/platform/revenue"
        />
        <Stat
          label="Organisations"
          value={data.organisations.total}
          hint={`${data.organisations.active} active · ${data.organisations.trial} on trial`}
          icon={Building2}
          href="/platform/organisations"
        />
        <Stat
          label="Users on the platform"
          value={data.users.total}
          hint={`${data.users.employees} employee records`}
          icon={Users}
          href="/platform/organisations"
        />
      </StatGrid>

      <div className="mt-3">
        <StatGrid>
          <Stat
            label="Payments awaiting review"
            value={data.queues.pendingPayments}
            hint={
              data.revenue.pendingPaise > 0
                ? `${formatMoney(data.revenue.pendingPaise)} pending`
                : "nothing waiting"
            }
            icon={CreditCard}
            tone={data.queues.pendingPayments > 0 ? "warning" : "neutral"}
            href="/platform/payments"
          />
          <Stat
            label="Password reset requests"
            value={data.queues.passwordResets}
            hint="OTPs waiting to be released"
            icon={KeyRound}
            tone={data.queues.passwordResets > 0 ? "warning" : "neutral"}
            href="/platform/password-resets"
          />
          <Stat
            label="Subscriptions expiring"
            value={data.queues.expiringSoon}
            hint="within 14 days"
            icon={AlertTriangle}
            tone={data.queues.expiringSoon > 0 ? "danger" : "neutral"}
            href="/platform/organisations"
          />
          <Stat
            label="Suspended organisations"
            value={data.organisations.suspended}
            icon={Building2}
            tone={data.organisations.suspended > 0 ? "danger" : "neutral"}
            href="/platform/organisations"
          />
        </StatGrid>
      </div>

      <div className="mt-5">
        <OrganisationsCard
          initial={{ rows: organisations.rows, total: organisations.total }}
        />
      </div>

      <div className="mt-5">
        <Section
          title="Recent payment activity"
          description={
            queueTotal > 0
              ? `${pluralise(queueTotal, "item")} needs your attention`
              : "Everything is up to date"
          }
          action={
            <Link
              href="/platform/payments"
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              View all
            </Link>
          }
        >
          {data.recentPayments.length === 0 ? (
            <EmptyState
              icon={CreditCard}
              title="No payments yet"
              description="Payment requests from organisations will appear here."
            />
          ) : (
            <>
              {/* Desktop table */}
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 font-medium">Order</th>
                      <th className="px-4 py-2 font-medium">Organisation</th>
                      <th className="px-4 py-2 font-medium">Seats</th>
                      <th className="px-4 py-2 text-right font-medium">Amount</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Raised</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.recentPayments.map((p) => (
                      <tr key={p.id} className="hover:bg-muted/40">
                        <td className="px-4 py-2.5 font-mono text-xs">{p.orderNumber}</td>
                        <td className="px-4 py-2.5">{p.organizationName}</td>
                        <td className="tabular px-4 py-2.5">{p.userCount}</td>
                        <td className="tabular px-4 py-2.5 text-right">{formatMoney(p.payablePaise)}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone={STATUS_TONE[p.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                            {p.status.replaceAll("_", " ").toLowerCase()}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {formatRelative(p.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards — a table squeezed onto a phone is unreadable. */}
              <ul className="divide-y divide-border sm:hidden">
                {data.recentPayments.map((p) => (
                  <li key={p.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{p.organizationName}</p>
                        <p className="font-mono text-xs text-muted-foreground">{p.orderNumber}</p>
                      </div>
                      <Badge tone={STATUS_TONE[p.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                        {p.status.replaceAll("_", " ").toLowerCase()}
                      </Badge>
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{pluralise(p.userCount, "seat")}</span>
                      <span className="tabular font-medium text-foreground">
                        {formatMoney(p.payablePaise)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>
      </div>
    </>
  );
}
