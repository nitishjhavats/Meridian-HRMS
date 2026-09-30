import Link from "next/link";
import { Hash } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { prisma } from "@/lib/db/prisma";
import { listOrders, listPaymentCodes } from "@/services/platform/payments";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDate, formatMoney, formatRelative, pluralise } from "@/lib/utils";
import { IssuePaymentCode } from "./IssuePaymentCode";
import { PaymentCodeActions } from "./PaymentCodeActions";

export const metadata = { title: "Payment codes" };
export const dynamic = "force-dynamic";

/**
 * Every code the platform owner has handed out, in one place.
 *
 * Two kinds, one list. A code issued against an order already in the queue
 * says "I have seen this payment" and approves the order the moment it is
 * typed in. A code made in advance -- for an organisation, or for anybody --
 * says "pay this, then confirm with these digits", may carry a discount, and
 * sends the order to the queue like a reference would. Until this page the
 * first kind hid inside a row action on Payments and the second did not exist.
 */

const STATE_TONE = {
  LIVE: "success",
  APPLIED: "info",
  USED: "neutral",
  EXPIRED: "neutral",
  REVOKED: "danger",
} as const;

const STATE_LABEL = {
  LIVE: "live",
  APPLIED: "applied at checkout",
  USED: "used",
  EXPIRED: "expired",
  REVOKED: "withdrawn",
} as const;

const TABS = [
  { key: "live", label: "Live" },
  { key: "used", label: "Used" },
  { key: "all", label: "All" },
] as const;

export default async function PaymentCodesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const ctx = await requirePageContext({ superadmin: true });
  const params = await searchParams;
  const tab = TABS.find((t) => t.key === params.tab) ?? TABS[0];

  const [codes, organisations, open] = await Promise.all([
    listPaymentCodes(ctx, { state: tab.key }),
    prisma.organization.findMany({
      where: { status: { not: "ARCHIVED" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    // Requests a code can still be issued against: open, and without one.
    listOrders(ctx, {
      status: ["INITIATED", "AWAITING_CONFIRMATION", "INFO_REQUESTED"],
      take: 100,
    }),
  ]);
  const openOrders = open.rows
    .filter((o) => !o.hasIssuedCode && o.minutesRemaining > 0)
    .map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      organizationName: o.organizationName,
      payablePaise: o.payablePaise,
      userCount: o.userCount,
    }));

  return (
    <>
      <PageHeader
        title="Payment codes"
        description={`${pluralise(codes.length, "code")} ${tab.key === "all" ? "in total" : tab.label.toLowerCase()}`}
        action={<IssuePaymentCode organisations={organisations} openOrders={openOrders} />}
      />

      <nav className="no-scrollbar mb-4 flex gap-1 overflow-x-auto" aria-label="Filter by state">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/platform/payment-codes?tab=${t.key}`}
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
        description="A code for an order approves it as soon as it is typed in. A code made in advance sends the order to the review queue, re-priced if it carries a discount."
      >
        <ResponsiveList
          items={codes}
          empty={
            <EmptyState
              icon={Hash}
              title="No codes here"
              description="Generate one for a payment you have received, or in advance for a deal made on the phone."
            />
          }
          head={
            <>
              <TH>For</TH>
              <TH>Kind</TH>
              <TH>Discount</TH>
              <TH>Issued</TH>
              <TH>Valid until</TH>
              <TH>State</TH>
              <TH>Actions</TH>
            </>
          }
          row={(c) => (
            <TR key={c.id}>
              <TD>
                {c.organizationId ? (
                  <Link
                    href={`/platform/organisations/${c.organizationId}`}
                    className="hover:underline"
                  >
                    {c.organizationName}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Any organisation</span>
                )}
                {c.orderNumber ? (
                  <span className="block font-mono text-xs text-muted-foreground">
                    {c.orderNumber}
                  </span>
                ) : null}
                {c.note ? (
                  <span className="block text-xs text-muted-foreground">{c.note}</span>
                ) : null}
              </TD>
              <TD className="text-xs">
                {c.kind === "ORDER" ? "Payment received" : "In advance"}
              </TD>
              <TD>
                {c.discountPercent != null ? (
                  <>
                    <span className="tabular">{c.discountPercent}%</span>
                    {c.maxDiscountPaise != null ? (
                      <span className="block text-xs text-muted-foreground">
                        max {formatMoney(c.maxDiscountPaise)}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TD>
              <TD className="text-xs">
                {formatRelative(c.issuedAt)}
                {c.issuedByName ? (
                  <span className="block text-muted-foreground">by {c.issuedByName}</span>
                ) : null}
              </TD>
              <TD className="text-xs">{formatDate(c.expiresAt)}</TD>
              <TD>
                <Badge tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge>
                {c.usedAt ? (
                  <span className="block text-xs text-muted-foreground">
                    {formatRelative(c.usedAt)}
                  </span>
                ) : null}
              </TD>
              <TD>
                <PaymentCodeActions code={c} />
              </TD>
            </TR>
          )}
          card={(c) => (
            <div key={c.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {c.organizationName ?? "Any organisation"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {c.kind === "ORDER" ? "Payment received" : "In advance"}
                    {c.orderNumber ? ` · ${c.orderNumber}` : ""}
                  </p>
                </div>
                <Badge tone={STATE_TONE[c.state]}>{STATE_LABEL[c.state]}</Badge>
              </div>

              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <div>
                  <dt className="text-muted-foreground">Discount</dt>
                  <dd className="tabular">
                    {c.discountPercent != null ? `${c.discountPercent}%` : "—"}
                    {c.maxDiscountPaise != null ? ` (max ${formatMoney(c.maxDiscountPaise)})` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Valid until</dt>
                  <dd>{formatDate(c.expiresAt)}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground">Issued</dt>
                  <dd>
                    {formatRelative(c.issuedAt)}
                    {c.issuedByName ? ` by ${c.issuedByName}` : ""}
                  </dd>
                </div>
                {c.note ? (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">Note</dt>
                    <dd>{c.note}</dd>
                  </div>
                ) : null}
              </dl>

              <div className="mt-3">
                <PaymentCodeActions code={c} />
              </div>
            </div>
          )}
        />
      </Section>
    </>
  );
}
