import Link from "next/link";
import { ArrowLeft, CheckCircle2, XCircle } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { asNotFound } from "@/lib/auth/notFound";
import { getOrderForOrg, getPlatformPricing } from "@/services/billing/orders";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UpiQr } from "@/components/billing/UpiQr";
import { formatDate, formatMoney } from "@/lib/utils";
import { ConfirmPayment } from "./ConfirmPayment";

export const metadata = { title: "Payment" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  APPROVED: "success",
  AWAITING_CONFIRMATION: "warning",
  INFO_REQUESTED: "info",
  INITIATED: "primary",
  REJECTED: "danger",
  EXPIRED: "neutral",
} as const;

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "org.billing.manage", what: "billing" });
  if (denied) return denied;


  const [view, pricing] = await Promise.all([
    getOrderForOrg(ctx, id).catch(asNotFound),
    getPlatformPricing(),
  ]);
  const { order } = view;
  const settled = ["APPROVED", "REJECTED", "EXPIRED"].includes(order.status);

  return (
    <>
      <Link
        href="/billing"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Back to billing
      </Link>

      <PageHeader
        title={`Payment ${order.orderNumber}`}
        description={`${order.userCount} seats · ${order.periodMonths} months`}
        action={
          <Badge tone={STATUS_TONE[order.status as keyof typeof STATUS_TONE] ?? "neutral"}>
            {order.status.replaceAll("_", " ").toLowerCase()}
          </Badge>
        }
      />

      {order.status === "APPROVED" ? (
        <div className="mb-4">
          <Alert tone="success" title="Payment approved">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
              {order.userCount} seats are active. {order.reviewNote ?? ""}
            </span>
          </Alert>
        </div>
      ) : null}

      {order.status === "REJECTED" ? (
        <div className="mb-4">
          <Alert tone="danger" title="Payment could not be confirmed">
            <span className="flex items-center gap-1.5">
              <XCircle className="size-4 shrink-0" aria-hidden />
              {order.reviewNote ?? "Contact the platform team for details."}
            </span>
          </Alert>
        </div>
      ) : null}

      {order.status === "INFO_REQUESTED" && order.infoRequestNote ? (
        <div className="mb-4">
          <Alert tone="warning" title="More information needed">
            {order.infoRequestNote}
          </Alert>
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2 lg:items-start">
        {/* ---------- what to pay ---------- */}
        <Card>
          <CardHeader>
            <CardTitle>{order.payablePaise === 0 ? "Nothing to pay" : "Pay by UPI"}</CardTitle>
          </CardHeader>
          <CardContent>
            {settled ? (
              <p className="text-sm text-muted-foreground">
                This request is closed, so payment details are no longer shown.
              </p>
            ) : order.payablePaise === 0 ? (
              // No QR and no UPI id for an amount of zero. A QR that encodes
              // ₹0 is one most UPI apps refuse to open, and showing the
              // payee's account for a transfer that will never happen invites
              // exactly the "how much do I send" question this screen exists
              // to answer.
              <p className="text-sm text-muted-foreground">
                The coupon {order.couponCode ? <span className="font-mono">{order.couponCode}</span> : null}{" "}
                covers the full amount, so there is no transfer to make. Confirm on the right.
              </p>
            ) : (
              <UpiQr
                upiLink={view.upiLink}
                upiId={order.upiId}
                payeeName={pricing.payeeName}
                amountPaise={order.payablePaise}
                orderNumber={order.orderNumber}
              />
            )}
          </CardContent>
        </Card>

        {/* ---------- confirm ---------- */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Order summary</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">
                    {order.userCount} users × {formatMoney(order.pricePerUserPaise)}
                  </dt>
                  <dd className="tabular">{formatMoney(order.subtotalPaise)}</dd>
                </div>
                {order.discountPaise > 0 ? (
                  <div className="flex justify-between text-success-text">
                    <dt>
                      Discount{" "}
                      {order.couponCode
                        ? `(${order.couponCode})`
                        : view.paymentCode
                          ? "(payment code)"
                          : ""}
                    </dt>
                    <dd className="tabular">−{formatMoney(order.discountPaise)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
                  <dt>Payable</dt>
                  <dd className="tabular">{formatMoney(order.payablePaise)}</dd>
                </div>
                {order.transactionRef ? (
                  <div className="flex justify-between pt-2 text-xs">
                    <dt className="text-muted-foreground">Your reference</dt>
                    <dd className="font-mono">{order.transactionRef}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between text-xs">
                  <dt className="text-muted-foreground">Raised</dt>
                  <dd>{formatDate(order.createdAt)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {!settled ? (
            <Section title={order.payablePaise === 0 ? "Confirm" : "Confirm your payment"}>
              <div className="p-4">
                <ConfirmPayment
                  orderId={order.id}
                  confirmationMode={view.confirmationMode}
                  hasIssuedCode={order.issuedCodeHash != null}
                  expiresAt={order.expiresAt.toISOString()}
                  status={order.status}
                  payablePaise={order.payablePaise}
                  boundCode={view.paymentCode !== null && !view.paymentCode.used}
                />
              </div>
            </Section>
          ) : null}
        </div>
      </div>
    </>
  );
}
