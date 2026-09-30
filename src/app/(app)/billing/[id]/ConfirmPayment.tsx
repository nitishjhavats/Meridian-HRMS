"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Clock, KeyRound, PartyPopper, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { toast } from "@/components/ui/toast";

/**
 * "I have paid" — the organisation's half of the confirmation handshake.
 *
 * Which form is shown depends on the platform's confirmation mode. In BOTH, the
 * organisation picks: quote your own UPI reference, or type the code the
 * platform owner gave you.
 */
export function ConfirmPayment({
  orderId,
  confirmationMode,
  hasIssuedCode,
  expiresAt,
  status,
  payablePaise,
  boundCode,
}: {
  orderId: string;
  confirmationMode: "UTR" | "CODE" | "BOTH";
  hasIssuedCode: boolean;
  expiresAt: string;
  status: string;
  /** Zero means there is nothing to reference and nothing to code. */
  payablePaise: number;
  /** A payment code was applied at checkout; one tap confirms with it. */
  boundCode: boolean;
}) {
  const router = useRouter();
  const [method, setMethod] = useState<"reference" | "code">(
    confirmationMode === "CODE" || boundCode ? "code" : "reference",
  );
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number>(() => msLeft(expiresAt));

  // A visible countdown, because a four-hour window that silently lapses is a
  // support ticket waiting to happen.
  useEffect(() => {
    const timer = setInterval(() => setRemaining(msLeft(expiresAt)), 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  // The window is the organisation's deadline to say "I have paid", and the
  // clock runs only while that is still owed (`clockRunning` in the order
  // machine). Once confirmed, the order waits on the platform and does not
  // lapse -- so this screen must not announce an expiry the server will never
  // record. Same for a request the platform has asked a question about.
  const onTheClock = status === "INITIATED";
  const expired = onTheClock && remaining <= 0;

  const nothingToPay = payablePaise === 0;
  // Confirming with the code bound at checkout, rather than typing digits.
  const useBound = boundCode && method === "code" && code.trim().length === 0;

  async function submit() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ order: { status: string } }>(`/api/billing/orders/${orderId}/submit`, {
          method: "POST",
          body: nothingToPay
            ? { mode: "nothing-due" }
            : method === "reference"
              ? { mode: "reference", reference: reference.trim(), note: note.trim() || undefined }
              : useBound
                ? { mode: "bound-code" }
                : { mode: "code", code: code.trim() },
        }),
      { error: "That could not be confirmed" },
    );
    setBusy(false);
    if (!result) return;
    // The code issued for this request approves it on the spot; every other
    // confirmation waits for the platform team. Which one this was is only
    // known once the server answers, so the message reads the status back.
    toast.success(
      result.order.status === "APPROVED"
        ? "Code accepted. Your seats are active."
        : nothingToPay
          ? "Confirmed. Your seats are set up as soon as the platform team approves it."
          : method === "reference"
            ? "Sent for review. You will be notified once it is approved."
            : "Code accepted — waiting for final approval.",
    );
    router.refresh();
  }

  if (expired) {
    return (
      <Alert tone="danger" title="This request has expired">
        The confirmation window has closed. Start a new payment request — if you have already
        paid, quote the same reference on the new one and it will be matched.
      </Alert>
    );
  }

  if (status === "AWAITING_CONFIRMATION") {
    return (
      <Alert tone="info" title="Waiting for approval">
        <span className="flex items-center gap-1.5">
          <CheckCircle2 className="size-4 shrink-0" aria-hidden />
          Your confirmation is with the platform team. Your seats activate as soon as they
          approve it. This request does not expire while it waits for them, so there is
          nothing more to do here.
        </span>
      </Alert>
    );
  }

  if (nothingToPay) {
    /**
     * A bill of zero, and one button.
     *
     * A coupon can cover the whole amount, and until this existed the order
     * then sat here asking for the UPI reference of a payment nobody could
     * make: nothing to quote, no code issued, and a four-hour window counting
     * down on an amount of nothing. The organisation was simply stuck.
     *
     * The button is not the authorisation -- the server checks the order's
     * own payable before it accepts this -- so there is nothing to type and
     * nothing to get wrong.
     */
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-success bg-success-muted px-4 py-3 text-success-text">
          <PartyPopper className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="text-sm">
            <p className="font-medium">You have nothing to pay.</p>
            <p className="mt-0.5">
              Your coupon covers the whole amount. There is no transfer to make and no reference
              to enter &mdash; just confirm, and your seats are set up once the platform team
              approves it.
            </p>
          </div>
        </div>
        <Button size="lg" className="w-full sm:w-auto" loading={busy} onClick={submit}>
          Move forward
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {onTheClock ? (
        <div className="flex items-center gap-2 rounded-md border border-warning bg-warning-muted px-3 py-2 text-sm text-warning-text">
          <Clock className="size-4 shrink-0" aria-hidden />
          <span>
            Confirm within <strong className="tabular">{formatCountdown(remaining)}</strong> or this
            request expires and you will need to raise a new one.
          </span>
        </div>
      ) : (
        // INFO_REQUESTED: the platform team has asked for something, and the
        // request waits for the answer rather than counting down.
        <p className="text-sm text-muted-foreground">
          Answer the platform team below. This request stays open until they review your
          answer.
        </p>
      )}

      {confirmationMode === "BOTH" ? (
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => setMethod("reference")}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              method === "reference" ? "bg-card shadow-sm" : "text-muted-foreground"
            }`}
          >
            <Receipt className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
            I have a reference
          </button>
          <button
            type="button"
            onClick={() => setMethod("code")}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              method === "code" ? "bg-card shadow-sm" : "text-muted-foreground"
            }`}
          >
            <KeyRound className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
            I have a code
          </button>
        </div>
      ) : null}

      {method === "reference" ? (
        <>
          <Field
            label="UPI transaction reference"
            htmlFor="reference"
            required
            hint="The UTR or transaction ID from your UPI app, so the payment can be matched."
          >
            <Input
              id="reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="e.g. 884512339021"
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <Field label="Anything else we should know? (optional)" htmlFor="note">
            <Textarea
              id="note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Paid from the company account at 10:42 am"
            />
          </Field>
          <Button
            size="lg"
            className="w-full"
            loading={busy}
            disabled={reference.trim().length < 3}
            onClick={submit}
          >
            I have paid — send for review
          </Button>
        </>
      ) : (
        <>
          {boundCode ? (
            <Alert tone="success" title="Your payment code is already on this request">
              You entered it while buying, so there is nothing to type again. Once you have
              paid, press the button below and the request goes to the platform team.
            </Alert>
          ) : !hasIssuedCode ? (
            <Alert tone="info" title="Ask for your confirmation code">
              Once you have paid, contact the platform team and ask for your payment confirmation
              code for this order. Enter it below to activate your seats.
            </Alert>
          ) : null}
          <Field
            label={boundCode ? "A different code (optional)" : "Payment confirmation code"}
            htmlFor="code"
            required={!boundCode}
            hint={
              boundCode
                ? "Only if the platform team gave you another code for this request."
                : "Six digits, issued to you by the platform team. It can only be used once."
            }
          >
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              placeholder="000000"
              className="tabular text-center font-mono text-2xl tracking-[0.4em]"
              autoComplete="one-time-code"
            />
          </Field>
          <Button
            size="lg"
            className="w-full"
            loading={busy}
            disabled={!useBound && code.trim().length < 4}
            onClick={submit}
          >
            {useBound ? "I have paid — confirm with my code" : "Confirm payment"}
          </Button>
        </>
      )}
    </div>
  );
}

function msLeft(expiresAt: string): number {
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
