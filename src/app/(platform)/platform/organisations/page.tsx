import Link from "next/link";
import { Building2 } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { listOrganizations } from "@/services/platform/organizations";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDate, pluralise } from "@/lib/utils";
import { CreateOrganization } from "./CreateOrganization";

export const metadata = { title: "Organisations" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  ACTIVE: "success",
  PENDING_PAYMENT: "warning",
  SUSPENDED: "danger",
  ARCHIVED: "neutral",
} as const;

const BILLING_TONE = {
  PAID: "success",
  TRIAL: "info",
  FREE_INTERNAL: "neutral",
} as const;

export default async function OrganisationsPage() {
  const ctx = await requirePageContext({ superadmin: true });
  const organizations = await listOrganizations(ctx);

  return (
    <>
      <PageHeader
        title="Organisations"
        description={`${pluralise(organizations.length, "tenant")} on this deployment`}
        action={<CreateOrganization />}
      />

      <Section title="All organisations" description="Newest first.">
        <ResponsiveList
          items={organizations}
          empty={
            <EmptyState
              icon={Building2}
              title="No organisations yet"
              description="Create the first one to get started."
            />
          }
          head={
            <>
              <TH>Organisation</TH>
              <TH>Status</TH>
              <TH>Billing</TH>
              <TH>Seats</TH>
              <TH>Users</TH>
              <TH>Renews</TH>
            </>
          }
          row={(org) => (
            <TR key={org.id}>
              <TD>
                <Link href={`/platform/organisations/${org.id}`} className="font-medium hover:underline">
                  {org.name}
                </Link>
                <span className="block font-mono text-xs text-muted-foreground">
                  {org.slug}
                  {org.city ? ` · ${org.city}` : ""}
                </span>
              </TD>
              <TD>
                <Badge tone={STATUS_TONE[org.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                  {org.status.replaceAll("_", " ").toLowerCase()}
                </Badge>
              </TD>
              <TD>
                <Badge tone={BILLING_TONE[org.billingMode as keyof typeof BILLING_TONE] ?? "neutral"}>
                  {org.billingMode.replace("_", " ").toLowerCase()}
                </Badge>
              </TD>
              <TD>
                <span className="tabular">
                  {org.activeEmployees} / {org.seats}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {org.utilisationPercent}% used
                </span>
              </TD>
              <TD className="tabular">{org.users}</TD>
              <TD className="text-xs text-muted-foreground">
                {org.trialEndsAt
                  ? `trial ends ${formatDate(org.trialEndsAt)}`
                  : org.currentPeriodEnd
                    ? formatDate(org.currentPeriodEnd)
                    : "—"}
              </TD>
            </TR>
          )}
          card={(org) => (
            <Link key={org.id} href={`/platform/organisations/${org.id}`} className="block">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{org.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">{org.slug}</p>
                </div>
                <Badge tone={STATUS_TONE[org.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                  {org.status.replaceAll("_", " ").toLowerCase()}
                </Badge>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {org.activeEmployees} of {org.seats} seats · {pluralise(org.users, "user")} ·{" "}
                {org.billingMode.replace("_", " ").toLowerCase()}
              </p>
            </Link>
          )}
        />
      </Section>
    </>
  );
}
