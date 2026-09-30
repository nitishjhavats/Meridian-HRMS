import { TicketPercent } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { prisma } from "@/lib/db/prisma";
import { listCoupons } from "@/services/platform/coupons";
import { getSettings } from "@/services/platform/settings";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDate, formatMoney, pluralise } from "@/lib/utils";
import { CouponListedToggle, CouponToggle, CreateCoupon } from "./CouponForm";
import { CouponRedemptions } from "./CouponRedemptions";

export const metadata = { title: "Coupons" };
export const dynamic = "force-dynamic";

const STATE_TONE = {
  LIVE: "success",
  SCHEDULED: "info",
  EXPIRED: "neutral",
  EXHAUSTED: "warning",
  INACTIVE: "neutral",
} as const;

/**
 * The conditions that are easy to forget you set.
 *
 * All four are invisible on the row otherwise, and each is a reason a customer
 * will say the coupon "does not work": it is not published, it is reserved for
 * one company, it is once per buyer, or it is for new customers only. Written
 * once and used by both the table and the card, because the two drifting apart
 * is how a list starts telling different stories at different widths.
 */
function conditionsOf(c: {
  listed: boolean;
  appliesToOrgName: string | null;
  maxPerOrganisation: number | null;
  firstPurchaseOnly: boolean;
}): string[] {
  const out: string[] = [];
  out.push(c.listed ? "shown at checkout" : "code only");
  if (c.appliesToOrgName) out.push(`only ${c.appliesToOrgName}`);
  if (c.maxPerOrganisation != null) out.push(`${c.maxPerOrganisation} per organisation`);
  if (c.firstPurchaseOnly) out.push("first purchase only");
  return out;
}

export default async function CouponsPage() {
  const ctx = await requirePageContext({ superadmin: true });
  const [coupons, settings, organisations] = await Promise.all([
    listCoupons(ctx),
    getSettings(),
    // For tying a coupon to one buyer. Read here rather than through a second
    // round trip: the dialog needs it the moment it opens, and this page is
    // already superadmin-only.
    prisma.organization.findMany({
      // Archived organisations are not going to buy anything, and a coupon
      // pointed at one could never be redeemed.
      where: { status: { not: "ARCHIVED" } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
  ]);
  const live = coupons.filter((c) => c.state === "LIVE");

  return (
    <>
      <PageHeader
        title="Coupons"
        description={`${pluralise(live.length, "live coupon")} of ${coupons.length} total`}
        action={
          <CreateCoupon
            pricePerUserPaise={settings.pricePerUserPaise}
            organisations={organisations}
          />
        }
      />

      <Section
        title="All coupons"
        description="A coupon is validated when the order is placed and again when it is approved."
      >
        <ResponsiveList
          items={coupons}
          empty={
            <EmptyState
              icon={TicketPercent}
              title="No coupons yet"
              description="Create one to offer a discount on seat purchases."
            />
          }
          head={
            <>
              <TH>Code</TH>
              <TH>Discount</TH>
              <TH>Valid</TH>
              <TH>Usage</TH>
              <TH>Given away</TH>
              <TH>State</TH>
              <TH>Actions</TH>
            </>
          }
          row={(c) => (
            <TR key={c.id}>
              <TD>
                <span className="font-mono font-medium">{c.code}</span>
                {c.description ? (
                  <span className="block text-xs text-muted-foreground">{c.description}</span>
                ) : null}
              </TD>
              <TD>
                <span className="tabular">{c.percent}%</span>
                {c.maxDiscountPaise ? (
                  <span className="block text-xs text-muted-foreground">
                    max {formatMoney(c.maxDiscountPaise)}
                  </span>
                ) : null}
              </TD>
              <TD className="text-xs">
                {formatDate(c.startsAt)} → {formatDate(c.expiresAt)}
              </TD>
              <TD className="tabular text-xs">
                {c.redemptionCount}
                {c.maxRedemptions ? ` / ${c.maxRedemptions}` : ""}
                {c.minUserCount || c.maxUserCount ? (
                  <span className="block text-muted-foreground">
                    {c.minUserCount ?? 1}–{c.maxUserCount ?? "∞"} users
                  </span>
                ) : null}
                <span className="block text-muted-foreground">
                  {conditionsOf(c).join(" · ")}
                </span>
              </TD>
              <TD numeric>{formatMoney(c.discountGivenPaise)}</TD>
              <TD>
                <Badge tone={STATE_TONE[c.state]}>{c.state.toLowerCase()}</Badge>
              </TD>
              <TD>
                <CouponListedToggle couponId={c.id} code={c.code} listed={c.listed} />
                <CouponToggle
                  couponId={c.id}
                  active={c.active}
                  redemptionCount={c.redemptionCount}
                />
                <CouponRedemptions couponId={c.id} code={c.code} count={c.redemptionCount} />
              </TD>
            </TR>
          )}
          card={(c) => (
            <div key={c.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium">{c.code}</p>
                  <p className="text-xs text-muted-foreground">
                    {c.percent}% off
                    {c.maxDiscountPaise ? ` · max ${formatMoney(c.maxDiscountPaise)}` : ""}
                  </p>
                </div>
                <Badge tone={STATE_TONE[c.state]}>{c.state.toLowerCase()}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatDate(c.startsAt)} → {formatDate(c.expiresAt)} · used {c.redemptionCount}
                {c.maxRedemptions ? ` of ${c.maxRedemptions}` : ""} ·{" "}
                {formatMoney(c.discountGivenPaise)} given
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {conditionsOf(c).join(" · ")}
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <CouponListedToggle couponId={c.id} code={c.code} listed={c.listed} />
                <CouponToggle
                  couponId={c.id}
                  active={c.active}
                  redemptionCount={c.redemptionCount}
                />
                <CouponRedemptions couponId={c.id} code={c.code} count={c.redemptionCount} />
              </div>
            </div>
          )}
        />
      </Section>
    </>
  );
}
