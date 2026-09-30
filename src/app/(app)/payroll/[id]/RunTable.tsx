"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Banknote, CheckCircle2, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
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
import { formatMoney } from "@/lib/utils";
import type { PaymentRow } from "@/services/payroll/disbursement";
import { PayrollBreakdown } from "./PayrollBreakdown";
import { Adjustments } from "./Adjustments";

export interface PayrollRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  designation: string | null;
  payableDays: number;
  basisDays: number;
  absentDays: number;
  lateCount: number;
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  paidPaise: number;
  settlement: string;
  warnings: string[];
}

const SETTLEMENT_TONE = {
  PAID: "success",
  PARTIALLY_PAID: "warning",
  UNPAID: "neutral",
} as const;

/**
 * The month's payroll, one row per employee.
 *
 * Two things hang off each row: the breakdown (how the number was reached) and
 * disbursement (what has actually been paid against it). Both are the questions
 * people ask when they look at a payroll screen.
 */
export function RunTable({
  items,
  canDisburse,
  canAdjust,
  runId,
  runStatus,
  scoped = false,
}: {
  items: PayrollRow[];
  canDisburse: boolean;
  canAdjust: boolean;
  runId: string;
  runStatus: string;
  /** The rows cover one reporting line, not the organisation. */
  scoped?: boolean;
}) {
  const router = useRouter();
  const [breakdownId, setBreakdownId] = useState<string | null>(null);
  const [payingFor, setPayingFor] = useState<PayrollRow | null>(null);
  const [busy, setBusy] = useState(false);

  const [amountRupees, setAmountRupees] = useState("");
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [remarks, setRemarks] = useState("");

  /**
   * What has already been paid against this payslip.
   *
   * `SalaryPayment` has been a full ledger since it was built -- many rows, a
   * derived status, a delete-with-a-reason -- and no screen listed it. So the
   * row could say "partially paid" and nothing on earth could say which part,
   * when, how, or by whom; and a payment typed in wrongly could not be found to
   * correct it. `method` and `remarks` were accepted by the API and sent by
   * nobody, so every payment on this instance would have read "BANK_TRANSFER"
   * whether or not it was.
   */
  const [history, setHistory] = useState<PaymentRow[] | null>(null);
  const [removing, setRemoving] = useState<PaymentRow | null>(null);
  const [removeReason, setRemoveReason] = useState("");

  const disbursable = runStatus === "APPROVED" || runStatus === "LOCKED";

  const loadHistory = useCallback((itemId: string) => {
    setHistory(null);
    void api<{ payments: PaymentRow[] }>(`/api/payroll/items/${itemId}/payments`)
      .then((r) => setHistory(r.payments))
      .catch(() => setHistory([]));
  }, []);

  function openPayment(row: PayrollRow) {
    setPayingFor(row);
    // Default to the whole outstanding amount; part-payments are the exception.
    setAmountRupees(String((row.netPaise - row.paidPaise) / 100));
    setReference("");
    setMethod("BANK_TRANSFER");
    setRemarks("");
    loadHistory(row.id);
  }

  /**
   * Closing a payslip that comes to nothing.
   *
   * Not a payment: no money moved, so no payment row is written and no bank
   * reference is asked for. Before this the row kept a "Pay" button that could
   * never succeed -- zero is refused as an amount, and anything above zero is
   * more than the nothing outstanding -- so the run could never be finished.
   */
  async function markSettled(row: PayrollRow) {
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/payroll/items/${row.id}/payments`, {
          method: "POST",
          body: { settleZeroNet: true },
        }),
      { success: "Marked as settled.", error: "That could not be settled" },
    );
    setBusy(false);
    if (result) router.refresh();
  }

  async function recordPayment() {
    if (!payingFor) return;
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/payroll/items/${payingFor.id}/payments`, {
          method: "POST",
          body: {
            amountPaise: Math.round(Number(amountRupees) * 100),
            paidOn,
            method,
            reference: reference.trim() || undefined,
            remarks: remarks.trim() || undefined,
          },
        }),
      { success: "Payment recorded.", error: "That payment could not be recorded" },
    );
    setBusy(false);
    if (result) {
      // The dialog stays open on purpose: the thing somebody wants to see after
      // recording a payment is the list with it in.
      setAmountRupees("");
      setReference("");
      setRemarks("");
      if (payingFor) loadHistory(payingFor.id);
      router.refresh();
    }
  }

  async function removePayment() {
    if (!removing || !payingFor) return;
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/payroll/items/${payingFor.id}/payments`, {
          method: "DELETE",
          body: { paymentId: removing.id, reason: removeReason.trim() },
        }),
      { success: "Payment removed.", error: "That payment could not be removed" },
    );
    setBusy(false);
    if (result) {
      setRemoving(null);
      setRemoveReason("");
      loadHistory(payingFor.id);
      router.refresh();
    }
  }

  const outstanding = payingFor ? payingFor.netPaise - payingFor.paidPaise : 0;

  return (
    <>
      <ResponsiveList
        items={items}
        empty={
          <EmptyState
            icon={Users}
            title={scoped ? "Nobody from your team is in this run" : "Nothing calculated yet"}
            description={
              scoped
                ? "Either the month has not been calculated yet, or none of your reports were on the rolls for it."
                : "Run the calculation to produce this month's payroll."
            }
          />
        }
        head={
          <>
            <TH>Employee</TH>
            <TH>Days</TH>
            <TH numeric>Gross</TH>
            <TH numeric>Deductions</TH>
            <TH numeric>Net</TH>
            <TH numeric>Paid</TH>
            <TH>Status</TH>
            <TH>Actions</TH>
          </>
        }
        row={(row) => (
          <TR key={row.id}>
            <TD>
              <button
                type="button"
                onClick={() => setBreakdownId(row.id)}
                className="text-left font-medium hover:underline"
              >
                {row.name}
              </button>
              <span className="block font-mono text-xs text-muted-foreground">
                {row.employeeCode}
                {row.designation ? ` · ${row.designation}` : ""}
              </span>
            </TD>
            <TD className="text-xs">
              <span className="tabular">
                {row.payableDays} / {row.basisDays}
              </span>
              {row.absentDays > 0 || row.lateCount > 0 ? (
                <span className="block text-muted-foreground">
                  {row.absentDays > 0 ? `${row.absentDays} absent` : ""}
                  {row.absentDays > 0 && row.lateCount > 0 ? " · " : ""}
                  {row.lateCount > 0 ? `${row.lateCount} late` : ""}
                </span>
              ) : null}
            </TD>
            <TD numeric>{formatMoney(row.grossPaise)}</TD>
            <TD numeric className="text-danger-text">
              {row.deductionsPaise > 0 ? `−${formatMoney(row.deductionsPaise)}` : "—"}
            </TD>
            <TD numeric className="font-medium">
              {formatMoney(row.netPaise)}
            </TD>
            <TD numeric>
              {row.paidPaise > 0 ? (
                <>
                  {formatMoney(row.paidPaise)}
                  {/* Part-paid is the state somebody needs to act on, so it says
                      what is left rather than only what went out. */}
                  {row.settlement === "PARTIALLY_PAID" ? (
                    <span className="block text-xs text-muted-foreground">
                      of {formatMoney(row.netPaise)}
                    </span>
                  ) : null}
                </>
              ) : (
                "—"
              )}
            </TD>
            <TD>
              <Badge tone={SETTLEMENT_TONE[row.settlement as keyof typeof SETTLEMENT_TONE] ?? "neutral"}>
                {row.settlement.replaceAll("_", " ").toLowerCase()}
              </Badge>
              {row.warnings.length > 0 ? (
                <span className="ml-1 text-xs text-warning-text">
                  {row.warnings.length} warning{row.warnings.length > 1 ? "s" : ""}
                </span>
              ) : null}
            </TD>
            <TD>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setBreakdownId(row.id)}>
                  Breakdown
                </Button>
                {/* The dialog decides from the status whether it can take a
                    new line or only show the ones there are: once the run is
                    approved nothing added could be applied, and it says so. */}
                {canAdjust ? (
                  <Adjustments
                    runId={runId}
                    employeeId={row.employeeId}
                    employeeName={row.name}
                    runStatus={runStatus}
                  />
                ) : null}
                {canDisburse && disbursable && row.settlement !== "PAID" ? (
                  row.netPaise === 0 ? (
                    <Button
                      size="sm"
                      variant="outline"
                      loading={busy}
                      onClick={() => void markSettled(row)}
                    >
                      <CheckCircle2 className="size-4" aria-hidden />
                      Mark paid
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => openPayment(row)}>
                      <Banknote className="size-4" aria-hidden />
                      Pay
                    </Button>
                  )
                ) : null}
              </div>
            </TD>
          </TR>
        )}
        card={(row) => (
          <div key={row.id}>
            <div className="flex items-start justify-between gap-3">
              <button
                type="button"
                onClick={() => setBreakdownId(row.id)}
                className="min-w-0 text-left"
              >
                <span className="block truncate text-sm font-medium">{row.name}</span>
                <span className="block font-mono text-xs text-muted-foreground">
                  {row.employeeCode}
                </span>
              </button>
              <Badge tone={SETTLEMENT_TONE[row.settlement as keyof typeof SETTLEMENT_TONE] ?? "neutral"}>
                {row.settlement.replaceAll("_", " ").toLowerCase()}
              </Badge>
            </div>

            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <dt className="text-muted-foreground">Days</dt>
                <dd className="tabular">
                  {row.payableDays}/{row.basisDays}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Net</dt>
                <dd className="tabular font-medium">{formatMoney(row.netPaise)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Paid</dt>
                <dd className="tabular">
                  {row.paidPaise > 0
                    ? row.settlement === "PARTIALLY_PAID"
                      ? `${formatMoney(row.paidPaise)} of ${formatMoney(row.netPaise)}`
                      : formatMoney(row.paidPaise)
                    : "—"}
                </dd>
              </div>
            </dl>

            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setBreakdownId(row.id)}>
                Breakdown
              </Button>
              {canDisburse && disbursable && row.settlement !== "PAID" ? (
                row.netPaise === 0 ? (
                  <Button size="sm" loading={busy} onClick={() => void markSettled(row)}>
                    <CheckCircle2 className="size-4" aria-hidden />
                    Mark paid
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => openPayment(row)}>
                    <Banknote className="size-4" aria-hidden />
                    Record payment
                  </Button>
                )
              ) : null}
            </div>
          </div>
        )}
      />

      <PayrollBreakdown
        itemId={breakdownId}
        open={breakdownId !== null}
        onClose={() => setBreakdownId(null)}
      />

      {/* ---------- record a payment ---------- */}
      <Dialog open={payingFor !== null} onOpenChange={(open) => !open && setPayingFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
            <DialogDescription>
              {payingFor?.name} · {formatMoney(outstanding)} outstanding
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <Field
              label="Amount (₹)"
              htmlFor="amount"
              required
              hint="Salary can be paid in several instalments; each one is recorded separately."
            >
              <Input
                id="amount"
                type="number"
                min={1}
                step="0.01"
                value={amountRupees}
                onChange={(e) => setAmountRupees(e.target.value)}
                className="tabular text-lg"
              />
            </Field>

            <Field label="Paid on" htmlFor="paidOn" required>
              <Input
                id="paidOn"
                type="date"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </Field>

            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <Field label="How it was paid" htmlFor="method">
                <Select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="UPI">UPI</option>
                  <option value="CHEQUE">Cheque</option>
                  <option value="CASH">Cash</option>
                  <option value="OTHER">Something else</option>
                </Select>
              </Field>

              <Field
                label="Reference"
                htmlFor="reference"
                hint="NEFT/UTR number, cheque number, etc."
              >
                <Input
                  id="reference"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  className="font-mono"
                  placeholder="NEFT123456"
                />
              </Field>
            </div>

            <Field label="Remarks" htmlFor="remarks" hint="Anything the next person should know.">
              <Input
                id="remarks"
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Paid late, salary account changed"
              />
            </Field>

            <section className="space-y-2">
              <h3 className="text-sm font-medium">Already paid</h3>
              {history === null ? (
                <p className="text-sm text-muted-foreground">Loading&hellip;</p>
              ) : history.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing paid against this yet.</p>
              ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {history.map((payment) => (
                    <li key={payment.id} className="flex items-start gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium tabular">
                          {formatMoney(payment.amountPaise)}
                          <span className="ml-2 font-normal text-muted-foreground">
                            {payment.paidOn}
                          </span>
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {payment.method.replaceAll("_", " ").toLowerCase()}
                          {payment.reference ? ` · ${payment.reference}` : ""}
                          {payment.recordedBy ? ` · by ${payment.recordedBy}` : ""}
                        </p>
                        {payment.remarks ? (
                          <p className="truncate text-xs text-muted-foreground">{payment.remarks}</p>
                        ) : null}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Remove this payment"
                        title="Remove this payment"
                        onClick={() => {
                          setRemoving(payment);
                          setRemoveReason("");
                        }}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayingFor(null)}>
              Close
            </Button>
            <Button
              loading={busy}
              disabled={!amountRupees || Number(amountRupees) <= 0}
              onClick={recordPayment}
            >
              Record {amountRupees ? formatMoney(Math.round(Number(amountRupees) * 100)) : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- remove a payment ---------- */}
      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this payment?</DialogTitle>
            <DialogDescription>
              {removing ? `${formatMoney(removing.amountPaise)} on ${removing.paidOn}` : ""} &mdash;
              the reason is written to the audit log, because a payment disappearing from a payroll
              record should never be untraceable.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Why" htmlFor="removeReason" required>
              <Input
                id="removeReason"
                value={removeReason}
                onChange={(e) => setRemoveReason(e.target.value)}
                placeholder="Entered against the wrong person"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(null)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={removeReason.trim().length === 0}
              onClick={removePayment}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
