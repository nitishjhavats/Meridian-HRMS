"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound, MessageCircleQuestion, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { formatMoney } from "@/lib/utils";

/**
 * Review controls for one payment request.
 *
 * The buttons shown are only ever the ones the state machine would accept; the
 * server checks again regardless, so a stale page cannot approve an expired
 * request.
 */

export interface ReviewTarget {
  id: string;
  orderNumber: string;
  organizationName: string;
  userCount: number;
  previousSeats: number;
  payablePaise: number;
  discountPaise: number;
  couponCode: string | null;
  status: string;
  transactionRef: string | null;
  payerNote: string | null;
  hasIssuedCode: boolean;
  minutesRemaining: number;
}

type Mode = "approve" | "reject" | "request_info" | null;

export function PaymentActions({
  order,
  confirmationMode,
}: {
  order: ReviewTarget;
  confirmationMode: "UTR" | "CODE" | "BOTH";
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  const reviewable = order.status === "AWAITING_CONFIRMATION" || order.status === "INFO_REQUESTED";
  const canIssueCode =
    confirmationMode !== "UTR" &&
    ["INITIATED", "AWAITING_CONFIRMATION", "INFO_REQUESTED"].includes(order.status);
  // The status, not the countdown: a confirmed request has no countdown.
  const expired = order.status === "EXPIRED";

  async function act() {
    if (!mode) return;
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/platform/payments/${order.id}/action`, {
          method: "POST",
          body: { action: mode, note: note.trim() || undefined },
        }),
      {
        success:
          mode === "approve"
            ? `${order.orderNumber} approved — ${order.userCount} seats are live.`
            : mode === "reject"
              ? "Request rejected."
              : "Information requested.",
      },
    );
    setBusy(false);
    if (result) {
      setMode(null);
      setNote("");
      router.refresh();
    }
  }

  async function issueCode() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ code: string }>(`/api/platform/payments/${order.id}/action`, {
          method: "POST",
          body: { action: "issue_code" },
        }),
      { success: "Code issued. It approves the request as soon as it is entered." },
    );
    setBusy(false);
    if (result) {
      setIssuedCode(result.code);
      router.refresh();
    }
  }

  async function revealCode() {
    setBusy(true);
    const result = await mutate(() =>
      api<{ code: string | null }>(`/api/platform/payments/${order.id}/action`, {
        method: "POST",
        body: { action: "reveal_code" },
      }),
    );
    setBusy(false);
    if (result?.code) setIssuedCode(result.code);
  }

  if (expired && !canIssueCode) {
    return <span className="text-xs text-muted-foreground">Window closed</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {reviewable && !expired ? (
        <>
          <Button size="sm" variant="success" onClick={() => setMode("approve")}>
            <Check className="size-4" aria-hidden />
            Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("request_info")}>
            <MessageCircleQuestion className="size-4" aria-hidden />
            <span className="hidden sm:inline">Ask</span>
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("reject")}>
            <X className="size-4" aria-hidden />
            <span className="hidden sm:inline">Reject</span>
          </Button>
        </>
      ) : null}

      {canIssueCode ? (
        <Button
          size="sm"
          variant="outline"
          loading={busy}
          onClick={order.hasIssuedCode ? revealCode : issueCode}
        >
          <KeyRound className="size-4" aria-hidden />
          {order.hasIssuedCode ? "Show code" : "Issue code"}
        </Button>
      ) : null}

      {/* ---------- confirm dialog ---------- */}
      <Dialog open={mode !== null} onOpenChange={(open) => !open && setMode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {mode === "approve"
                ? "Approve this payment"
                : mode === "reject"
                  ? "Reject this payment"
                  : "Ask for more information"}
            </DialogTitle>
            <DialogDescription>
              {order.orderNumber} · {order.organizationName}
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {mode === "approve" ? (
              <Alert tone="info" title="What this does">
                Seats go from {order.previousSeats} to {order.userCount} and the subscription
                becomes active. {formatMoney(order.payablePaise)} is recorded as collected
                {order.couponCode ? `, with coupon ${order.couponCode} redeemed` : ""}.
              </Alert>
            ) : null}

            {order.transactionRef ? (
              <div className="rounded-md border border-border p-3 text-sm">
                <p className="text-xs text-muted-foreground">Reference given by the organisation</p>
                <p className="mt-0.5 font-mono">{order.transactionRef}</p>
                {order.payerNote ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">{order.payerNote}</p>
                ) : null}
              </div>
            ) : null}

            <Field
              label={mode === "approve" ? "Note (optional)" : "Reason"}
              htmlFor="note"
              required={mode !== "approve"}
              hint={
                mode === "approve"
                  ? "Recorded against the subscription history."
                  : "The organisation sees this, so be specific about what they should do."
              }
            >
              <Textarea
                id="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder={
                  mode === "approve"
                    ? "Verified against the bank statement"
                    : mode === "reject"
                      ? "We could not find this transaction"
                      : "Please send a screenshot of the payment confirmation"
                }
              />
            </Field>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button
              variant={mode === "approve" ? "success" : mode === "reject" ? "danger" : "primary"}
              loading={busy}
              disabled={mode !== "approve" && note.trim().length === 0}
              onClick={act}
            >
              {mode === "approve" ? "Approve payment" : mode === "reject" ? "Reject" : "Send request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- issued code ---------- */}
      <Dialog open={issuedCode !== null} onOpenChange={(open) => !open && setIssuedCode(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Confirmation code</DialogTitle>
            <DialogDescription>
              Share this with {order.organizationName} yourself — the app never sends it to them.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="rounded-lg border border-border bg-muted p-6 text-center">
              <p className="tabular font-mono text-3xl font-semibold tracking-[0.3em]">
                {issuedCode}
              </p>
            </div>
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => {
                if (issuedCode) {
                  void copyText(issuedCode, "Code copied");
                }
              }}
            >
              <Copy className="size-4" aria-hidden />
              Copy code
            </Button>
            <p className="mt-3 text-xs text-muted-foreground">
              They enter it on their billing page, and the moment they do the request is
              approved in your name and their seats go live &mdash; so only issue it once you
              have seen the money. It is single-use and expires with the request. Every time
              this code is shown it is written to the audit log.
            </p>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
