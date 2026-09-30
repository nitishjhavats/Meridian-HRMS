import Link from "next/link";
import { ArrowLeft, CreditCard, Eye, Users, Wallet } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { asNotFound } from "@/lib/auth/notFound";
import { getOrganization, listOrganizationPeople } from "@/services/platform/organizations";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import {
  ResponsiveList,
  TBody,
  TD,
  TH,
  THead,
  Table,
  TableWrap,
  TR,
} from "@/components/ui/table";
import { formatDate, formatMoney, formatRelative, pluralise } from "@/lib/utils";
import { FeatureGrants, StatusControls } from "./OrganizationControls";
import { LicenceAndAi } from "./LicenceAndAi";
import { People } from "./People";
import { OrganizationProfile } from "./OrganizationProfile";

export const metadata = { title: "Organisation" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  ACTIVE: "success",
  PENDING_PAYMENT: "warning",
  SUSPENDED: "danger",
  ARCHIVED: "neutral",
} as const;

export default async function OrganizationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { id } = await params;
  const { q, page } = await searchParams;
  const ctx = await requirePageContext({ superadmin: true });
  // An id that names nothing is a 404 page, not the crash screen.
  const [org, people] = await Promise.all([
    getOrganization(ctx, id).catch(asNotFound),
    listOrganizationPeople(ctx, id, { search: q, page: Number(page) || 1 }).catch(asNotFound),
  ]);

  return (
    <>
      <Link
        href="/platform/organisations"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All organisations
      </Link>

      <PageHeader
        title={org.name}
        description={`${org.slug}${org.city ? ` · ${org.city}` : ""}${
          org.legalName ? ` · ${org.legalName}` : ""
        }`}
        action={
          <Badge tone={STATUS_TONE[org.status as keyof typeof STATUS_TONE] ?? "neutral"}>
            {org.status.replaceAll("_", " ").toLowerCase()}
          </Badge>
        }
      />

      {org.status === "SUSPENDED" && org.suspendedReason ? (
        <div className="mb-4">
          <Alert tone="danger" title={`Suspended ${formatRelative(org.suspendedAt ?? new Date())}`}>
            {org.suspendedReason}
          </Alert>
        </div>
      ) : null}

      <StatGrid>
        <Stat
          label="Seats"
          value={`${org.seats.used} / ${org.seats.seats}`}
          hint={`${org.seats.utilisationPercent}% utilised`}
          icon={Users}
          tone={org.seats.overage > 0 ? "danger" : "primary"}
        />
        <Stat label="Employee records" value={org._count.employees} icon={Users} />
        <Stat label="Login accounts" value={org._count.users} icon={Users} />
        <Stat
          label={org.subscription?.billingMode === "TRIAL" ? "Trial ends" : "Renews"}
          value={
            org.subscription
              ? formatDate(org.subscription.trialEndsAt ?? org.subscription.currentPeriodEnd)
              : "—"
          }
          hint={org.subscription?.billingMode.replace("_", " ").toLowerCase()}
          icon={CreditCard}
        />
      </StatGrid>

      <div className="mt-5">
        <LicenceAndAi
          organizationId={org.id}
          subscription={
            org.subscription
              ? {
                  seats: org.subscription.seats,
                  billingMode: org.subscription.billingMode,
                  billingCycle: org.subscription.billingCycle,
                  currentPeriodEnd: org.subscription.currentPeriodEnd.toISOString(),
                  status: org.subscription.status,
                }
              : null
          }
        />
      </div>

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2 lg:items-start">
        <Section
          title="Module access"
          description="What this organisation may use. Their own admin chooses what to switch on."
        >
          <FeatureGrants organizationId={org.id} modules={org.modules} />
        </Section>

        <Section title="Subscription & status">
          <StatusControls
            organizationId={org.id}
            organizationName={org.name}
            status={org.status}
            seats={org.subscription?.seats ?? 0}
          />
        </Section>

        <OrganizationProfile
          organizationId={org.id}
          initial={{
            name: org.name,
            legalName: org.legalName ?? "",
            slug: org.slug,
            email: org.email ?? "",
            phone: org.phone ?? "",
            website: org.website ?? "",
            industry: org.industry ?? "",
            addressLine1: org.addressLine1 ?? "",
            addressLine2: org.addressLine2 ?? "",
            city: org.city ?? "",
            state: org.state ?? "",
            country: org.country,
            postalCode: org.postalCode ?? "",
            cin: org.cin ?? "",
            gstin: org.gstin ?? "",
            panNumber: org.panNumber ?? "",
            tan: org.tan ?? "",
            pfCode: org.pfCode ?? "",
            esiCode: org.esiCode ?? "",
            timezone: org.timezone,
            currency: org.currency,
            probationDays: org.probationDays,
            employeeCodePrefix: org.employeeCodePrefix,
          }}
        />

        <People organizationId={org.id} page={people} />

        <Section
          title="Payment history"
          description={pluralise(org.paymentOrders.length, "recent request")}
        >
          <ResponsiveList
            items={org.paymentOrders}
            empty={<EmptyState icon={Wallet} title="No payments yet" />}
            head={
              <>
                <TH>Order</TH>
                <TH>Seats</TH>
                <TH numeric>Amount</TH>
                <TH>Status</TH>
              </>
            }
            row={(order) => (
              <TR key={order.id}>
                <TD className="font-mono text-xs">{order.orderNumber}</TD>
                <TD className="tabular">{order.userCount}</TD>
                <TD numeric>{formatMoney(order.payablePaise)}</TD>
                <TD className="text-xs">{order.status.replaceAll("_", " ").toLowerCase()}</TD>
              </TR>
            )}
            card={(order) => (
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs">{order.orderNumber}</p>
                  <p className="text-xs text-muted-foreground">
                    {pluralise(order.userCount, "seat")} ·{" "}
                    {order.status.replaceAll("_", " ").toLowerCase()}
                  </p>
                </div>
                <p className="tabular shrink-0 text-sm font-medium">
                  {formatMoney(order.payablePaise)}
                </p>
              </div>
            )}
          />
        </Section>

        <div className="lg:col-span-2">
          <Section
            title="Seat history"
            description="Every change to this organisation's entitlement, and what caused it."
          >
            {org.subscriptionHistory.length === 0 ? (
              <EmptyState icon={CreditCard} title="No changes recorded yet" />
            ) : (
              <TableWrap className="hidden sm:block">
                <Table>
                  <THead>
                    <tr>
                      <TH>When</TH>
                      <TH>Seats</TH>
                      <TH numeric>Amount</TH>
                      <TH>Period end</TH>
                      <TH>Note</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {org.subscriptionHistory.map((row) => (
                      <TR key={row.id}>
                        <TD className="text-xs text-muted-foreground">
                          {formatDate(row.createdAt)}
                        </TD>
                        <TD className="tabular">
                          {row.previousSeats} → {row.newSeats}
                        </TD>
                        <TD numeric>{formatMoney(row.amountPaise)}</TD>
                        <TD className="text-xs">{formatDate(row.newPeriodEnd)}</TD>
                        <TD className="text-xs text-muted-foreground">{row.note ?? "—"}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
            )}

            {/* Five columns is too many for a phone, and this is the screen a
                platform owner opens on one when a customer calls. The table
                keeps every column from `sm` up; below it the same rows read as
                sentences. */}
            {org.subscriptionHistory.length > 0 ? (
              <ul className="divide-y divide-border sm:hidden">
                {org.subscriptionHistory.map((row) => (
                  <li key={row.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium tabular">
                          {row.previousSeats} &rarr; {row.newSeats} seats
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDate(row.createdAt)} &middot; to {formatDate(row.newPeriodEnd)}
                        </p>
                      </div>
                      <p className="tabular shrink-0 text-sm">{formatMoney(row.amountPaise)}</p>
                    </div>
                    {row.note ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.note}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </div>
      </div>

      <p className="mt-6 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Eye className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          Signing in as somebody here lasts thirty minutes and lets you change things as they
          could. It is written to this organisation&apos;s own audit log, with your email and the
          reason you gave, so nothing you do can be mistaken for something they did.
        </span>
      </p>
    </>
  );
}
