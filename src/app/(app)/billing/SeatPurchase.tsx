"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Minus, Plus, Tag, TicketPercent } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Alert, LoadFailed } from "@/components/ui/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, mutate } from "@/lib/client/api";
import { formatMoney, pluralise } from "@/lib/utils";

/**
 * Seat selector.
 *
 * Every figure on screen comes from the server's quote endpoint — the browser
 * never multiplies a price itself, so what is displayed is always what will be
 * charged and what the UPI QR will carry.
 */

interface Quote {
  userCount: number;
  periodMonths: number;
  pricePerUserPaise: number;
  subtotalPaise: number;
  discountPaise: number;
  payablePaise: number;
  coupon: { code: string; percent: number } | null;
  /** A six-digit Broadmate payment code typed into the same box. */
  paymentCode: { percent: number | null; discountPaise: number } | null;
  couponError: string | null;
}

/**
 * An offer the buyer is allowed to see.
 *
 * `applies` is answered against the seat count on screen right now, which is
 * why this is re-fetched when that number changes. One that does not apply is
 * still listed, with `reason` saying why -- "needs 50 users or more" is the
 * difference between a buyer thinking there are no offers and a buyer working
 * out that thirty more seats would pay for themselves.
 */
interface CheckoutCoupon {
  code: string;
  description: string | null;
  percent: number;
  maxDiscountPaise: number | null;
  expiresAt: string;
  applies: boolean;
  reason: string | null;
}

const PRESETS = [10, 25, 50, 100];

/**
 * The quoted rate is ₹59 per user per month, so a month is the honest default —
 * 10 users reads as ₹590, exactly as quoted. Longer terms are a convenience,
 * not a different price.
 */
const PERIODS = [
  { months: 1, label: "1 month" },
  { months: 3, label: "3 months" },
  { months: 6, label: "6 months" },
  { months: 12, label: "12 months" },
];

export function SeatPurchase({
  currentSeats,
  activeEmployees,
}: {
  currentSeats: number;
  activeEmployees: number;
}) {
  const router = useRouter();
  // `null` while the box is empty. This is the number the buyer is charged for,
  // so nothing here may fill it in on their behalf.
  const [userCount, setUserCount] = useState<number | null>(
    Math.max(currentSeats || 10, activeEmployees, 1),
  );
  const [periodMonths, setPeriodMonths] = useState(1);
  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [offers, setOffers] = useState<CheckoutCoupon[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  /**
   * A quote that fails is said under the bill. It used to be swallowed:
   * "Users —", "Payable —", Continue disabled and not a word about why, which
   * on a payment screen reads as broken. The stale quote is still dropped --
   * a price on screen must be the price the server would charge -- but the
   * reason takes its place, with a retry when one could help. A dead session
   * never gets this far, because `api()` sends it to sign in.
   */
  const fetchQuote = useCallback(
    async (seats: number, months: number, coupon: string | null) => {
      setLoading(true);
      try {
        const result = await api<Quote>("/api/billing/quote", {
          method: "POST",
          body: { userCount: seats, periodMonths: months, couponCode: coupon },
        });
        setQuote(result);
        setQuoteError(null);
      } catch (error) {
        setQuote(null);
        setQuoteError(error);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    // An empty box is not a seat count. The last quote stays on screen rather
    // than the bill flickering to a price nobody asked for mid-keystroke.
    if (userCount === null) return;
    const timer = setTimeout(() => void fetchQuote(userCount, periodMonths, appliedCoupon), 250);
    return () => clearTimeout(timer);
  }, [userCount, periodMonths, appliedCoupon, fetchQuote]);

  /**
   * The offers, re-read when the seat count changes.
   *
   * Whether a coupon applies depends on how many seats are being bought, so a
   * list fetched once would go on offering a fifty-seat deal to somebody who
   * has since changed their mind and wants ten. A failure leaves the list empty
   * rather than showing an error: not being able to see the offers is a smaller
   * problem than a red box on a payment screen, and the code box still works.
   */
  useEffect(() => {
    if (userCount === null) return;
    const timer = setTimeout(() => {
      void api<{ coupons: CheckoutCoupon[] }>(`/api/billing/coupons?userCount=${userCount}`)
        .then((r) => setOffers(r.coupons))
        .catch(() => setOffers([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [userCount]);

  async function createOrder() {
    if (userCount === null) return;
    setCreating(true);
    const result = await mutate(
      () =>
        api<{ order: { id: string } }>("/api/billing/orders", {
          method: "POST",
          body: { userCount, periodMonths, couponCode: appliedCoupon },
        }),
      { error: "Could not start the payment" },
    );
    setCreating(false);
    if (result) {
      router.push(`/billing/${result.order.id}`);
      router.refresh();
    }
  }

  const belowCurrentUse = userCount !== null && userCount < activeEmployees;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Buy seats</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field
          label="How many users do you need?"
          htmlFor="userCount"
          hint={`You currently have ${pluralise(activeEmployees, "active employee")}${
            currentSeats > 0 ? ` on ${currentSeats} seats` : ""
          }.`}
        >
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setUserCount((v) => Math.max(1, (v ?? 0) - 1))}
              aria-label="One fewer user"
            >
              <Minus className="size-4" />
            </Button>
            <NumberField
              id="userCount"
              min={1}
              max={10_000}
              value={userCount}
              onValueChange={setUserCount}
              className="tabular text-center text-lg font-semibold"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => setUserCount((v) => Math.min(10_000, (v ?? 0) + 1))}
              aria-label="One more user"
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </Field>

        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset}
              type="button"
              size="sm"
              variant={userCount === preset ? "primary" : "outline"}
              onClick={() => setUserCount(preset)}
            >
              {preset} users
            </Button>
          ))}
        </div>

        <Field label="Billing period" htmlFor="period">
          <div className="flex flex-wrap gap-2" id="period">
            {PERIODS.map((p) => (
              <Button
                key={p.months}
                type="button"
                size="sm"
                variant={periodMonths === p.months ? "primary" : "outline"}
                onClick={() => setPeriodMonths(p.months)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </Field>

        {belowCurrentUse ? (
          <Alert tone="warning">
            You have {activeEmployees} active employees. Buying {userCount} seats will not remove
            anyone, but you will not be able to activate new people until you add more.
          </Alert>
        ) : null}

        {/* ---------- coupon ---------- */}
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
            <TicketPercent className="size-4 text-muted-foreground" aria-hidden />
            Have a coupon or a payment code?
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
              placeholder="LAUNCH10 or 481920"
              className="min-w-28 flex-1 font-mono uppercase"
              aria-label="Coupon or payment code"
              // The quote schema caps a code at 32 characters. Past that the
              // whole quote came back 422 and the bill went blank, which is
              // not what a wrong coupon should do to a price.
              maxLength={32}
            />

            {/**
              * The offers, beside the box rather than instead of it.
              *
              * A private code still has to be typeable -- most coupons are
              * emailed to one customer and never listed -- so this sits next to
              * the input and not in place of it. Choosing one applies it at
              * once: the buyer has already made the choice, and asking them to
              * press Apply afterwards is asking twice.
              *
              * A native select on purpose. It gives a phone its own picker, it
              * is keyboard-navigable for free, and `disabled` on an option is
              * the one way to show an offer that cannot be taken without
              * pretending it can.
              */}
            {offers.length > 0 ? (
              <Select
                aria-label="Choose an offer"
                className="w-auto max-w-full"
                value=""
                onChange={(e) => {
                  const code = e.target.value;
                  if (!code) return;
                  setCouponInput(code);
                  setAppliedCoupon(code);
                }}
              >
                <option value="">Offers ({offers.filter((o) => o.applies).length})</option>
                {offers.map((offer) => (
                  <option key={offer.code} value={offer.code} disabled={!offer.applies}>
                    {offer.code} &mdash; {offer.percent}% off
                    {offer.applies ? "" : ` (${offer.reason ?? "not available"})`}
                  </option>
                ))}
              </Select>
            ) : null}

            {appliedCoupon && couponInput.trim() === appliedCoupon ? (
              <Button
                variant="outline"
                onClick={() => {
                  setAppliedCoupon(null);
                  setCouponInput("");
                }}
              >
                Remove
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={!couponInput.trim()}
                onClick={() => setAppliedCoupon(couponInput.trim())}
              >
                Apply
              </Button>
            )}
          </div>
          {quote?.couponError ? (
            <p className="mt-2 text-xs text-danger-text" role="alert">
              {quote.couponError} Remove it, or type another code and apply it, to continue.
            </p>
          ) : null}
          {quote?.coupon ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-success-text">
              <Tag className="size-3" aria-hidden />
              {quote.coupon.code} applied — {quote.coupon.percent}% off
            </p>
          ) : null}
          {quote?.paymentCode ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-success-text">
              <Tag className="size-3" aria-hidden />
              Payment code applied
              {quote.paymentCode.percent ? ` — ${quote.paymentCode.percent}% off` : ""}. Once you
              have paid, one tap confirms it.
            </p>
          ) : null}
        </div>

        {/* ---------- the bill ---------- */}
        <dl className="space-y-1.5 rounded-lg bg-muted p-4 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">
              {quote
                ? `${quote.userCount} users × ${formatMoney(quote.pricePerUserPaise)}${
                    quote.periodMonths > 1 ? ` × ${quote.periodMonths} months` : ""
                  }`
                : "Users"}
            </dt>
            <dd className="tabular">{quote ? formatMoney(quote.subtotalPaise) : "—"}</dd>
          </div>
          {quote && quote.discountPaise > 0 ? (
            <div className="flex justify-between text-success-text">
              <dt>
                Discount
                {quote.coupon
                  ? ` (${quote.coupon.code})`
                  : quote.paymentCode
                    ? " (payment code)"
                    : ""}
              </dt>
              <dd className="tabular">−{formatMoney(quote.discountPaise)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
            <dt>Payable</dt>
            <dd className="tabular">{quote ? formatMoney(quote.payablePaise) : "—"}</dd>
          </div>
          {quote ? (
            <p className="pt-1 text-xs text-muted-foreground">
              {formatMoney(quote.pricePerUserPaise)} per active user per month
              {quote.periodMonths > 1
                ? ` · ${formatMoney(Math.round(quote.payablePaise / quote.periodMonths))} a month`
                : ""}
              . Employees who have left do not use a seat.
            </p>
          ) : null}
        </dl>

        {quoteError !== null && !loading && userCount !== null ? (
          <LoadFailed
            compact
            error={quoteError}
            what="The price"
            onRetry={() => void fetchQuote(userCount, periodMonths, appliedCoupon)}
          />
        ) : null}

        {/**
          * Held while the applied coupon is refused.
          *
          * The quote already says the code cannot be used, and the server
          * would refuse the order for the same reason -- but every press of
          * Continue spends one of the ten order attempts an organisation gets
          * an hour, which exist to stop payment codes being guessed. Ten
          * tries at a coupon that was never going to work locked a real
          * buyer out of paying for the rest of the hour. The red line under
          * the box now says what to do instead.
          */}
        <Button
          size="lg"
          className="w-full"
          loading={creating || loading}
          disabled={!quote || userCount === null || Boolean(quote.couponError)}
          onClick={createOrder}
        >
          Continue to payment
          <ArrowRight className="size-4" aria-hidden />
        </Button>
      </CardContent>
    </Card>
  );
}
