"use client";

import { useEffect, useState } from "react";
import { Calculator, Receipt } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Alert, LoadingState } from "@/components/ui/states";
import { api } from "@/lib/client/api";
import { formatDate, formatDuration, formatMoney } from "@/lib/utils";

/**
 * "How was this calculated?"
 *
 * The engine records a trace line for every amount it produces — the stage, the
 * formula, the inputs and the result — and this simply renders it. An employee
 * disputing a deduction can be shown the arithmetic instead of being told the
 * system says so.
 */

interface TraceLine {
  stage: string;
  label: string;
  formula: string;
  inputs: Record<string, string | number>;
  amountPaise: number;
}

interface LineItem {
  code: string;
  label: string;
  amountPaise: number;
  kind: "EARNING" | "DEDUCTION";
  prorated: boolean;
}

interface ItemDetail {
  id: string;
  label: string;
  name: string;
  employee: { employeeCode: string; designation: { title: string } | null };
  ctcMonthlyPaise: number;
  basisDays: string | number;
  payableDays: string | number;
  presentDays: string | number;
  absentDays: string | number;
  paidLeaveDays: string | number;
  unpaidLeaveDays: string | number;
  halfDays: string | number;
  weekOffDays: string | number;
  holidayDays: string | number;
  extraDays: string | number;
  lateCount: number;
  overtimeMinutes: number;
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  paidPaise: number;
  earnings: LineItem[];
  deductions: LineItem[];
  trace: TraceLine[];
  warnings: string[];
  payments: { id: string; amountPaise: number; paidOn: string; method: string; reference: string | null }[];
}

const STAGE_LABELS: Record<string, string> = {
  PERIOD: "Period",
  RESOLVE_SALARY: "Salary",
  PAYABLE_DAYS: "Payable days",
  PRORATE_EARNINGS: "Earnings",
  ABSENCE: "Absence",
  LATE_DEDUCTION: "Late arrivals",
  EARLY_LEAVE_DEDUCTION: "Early departures",
  UNPAID_LEAVE_DEDUCTION: "Unpaid leave",
  EXTRA_DAY_CREDIT: "Extra days",
  OVERTIME_CREDIT: "Overtime",
  ADJUSTMENTS: "Adjustments",
  STATUTORY_DEDUCTIONS: "Statutory",
  ADVANCE_RECOVERY: "Advance recovery",
  ROUNDING: "Rounding",
  RESULT: "Result",
};

export function PayrollBreakdown({
  itemId,
  open,
  onClose,
}: {
  itemId: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !itemId) return;
    setLoading(true);
    setError(null);
    api<ItemDetail>(`/api/payroll/items/${itemId}`)
      .then(setDetail)
      .catch(() => setError("That payslip could not be loaded."))
      .finally(() => setLoading(false));
  }, [itemId, open]);

  const num = (value: string | number) => Number(value);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detail ? detail.name : "Payslip"}</DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.employee.employeeCode} · ${detail.label}${
                  detail.employee.designation ? ` · ${detail.employee.designation.title}` : ""
                }`
              : "Loading the breakdown…"}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-5">
          {loading ? <LoadingState label="Loading the breakdown…" /> : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}

          {detail ? (
            <>
              {detail.warnings.length > 0 ? (
                <Alert tone="warning" title="Worth checking">
                  <ul className="list-inside list-disc">
                    {detail.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              {/* ---------- attendance ---------- */}
              <section>
                <h3 className="mb-2 text-sm font-semibold">Attendance</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
                  <Fact label="Payable days" value={`${num(detail.payableDays)} / ${num(detail.basisDays)}`} />
                  <Fact label="Present" value={num(detail.presentDays)} />
                  <Fact label="Paid leave" value={num(detail.paidLeaveDays)} />
                  <Fact label="Absent" value={num(detail.absentDays)} tone={num(detail.absentDays) > 0 ? "danger" : undefined} />
                  <Fact label="Half days" value={num(detail.halfDays)} />
                  <Fact label="Week offs" value={num(detail.weekOffDays)} />
                  <Fact label="Extra days" value={num(detail.extraDays)} />
                  <Fact
                    label="Late"
                    value={detail.lateCount}
                    tone={detail.lateCount > 0 ? "warning" : undefined}
                  />
                  {detail.overtimeMinutes > 0 ? (
                    <Fact label="Overtime" value={formatDuration(detail.overtimeMinutes)} />
                  ) : null}
                </dl>
              </section>

              {/* ---------- the money ---------- */}
              <section className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Earnings</h3>
                  <ul className="space-y-1 text-sm">
                    {detail.earnings.map((e) => (
                      <li key={e.code} className="flex justify-between gap-3">
                        <span className="min-w-0 truncate text-muted-foreground">
                          {e.label}
                          {e.prorated ? (
                            <span className="ml-1 text-xs">(prorated)</span>
                          ) : null}
                        </span>
                        <span className="tabular shrink-0">{formatMoney(e.amountPaise)}</span>
                      </li>
                    ))}
                    <li className="flex justify-between gap-3 border-t border-border pt-1 font-medium">
                      <span>Gross</span>
                      <span className="tabular">{formatMoney(detail.grossPaise)}</span>
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold">Deductions</h3>
                  {detail.deductions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {detail.deductions.map((d) => (
                        <li key={d.code} className="flex justify-between gap-3">
                          <span className="min-w-0 truncate text-muted-foreground">{d.label}</span>
                          <span className="tabular shrink-0 text-danger-text">
                            −{formatMoney(d.amountPaise)}
                          </span>
                        </li>
                      ))}
                      <li className="flex justify-between gap-3 border-t border-border pt-1 font-medium">
                        <span>Total</span>
                        <span className="tabular text-danger-text">
                          −{formatMoney(detail.deductionsPaise)}
                        </span>
                      </li>
                    </ul>
                  )}
                </div>
              </section>

              <div className="flex items-baseline justify-between rounded-lg bg-muted p-3">
                <span className="text-sm font-medium">Net payable</span>
                <span className="tabular text-xl font-semibold">{formatMoney(detail.netPaise)}</span>
              </div>

              {/* ---------- payments ---------- */}
              {detail.payments.length > 0 ? (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                    <Receipt className="size-4 text-muted-foreground" aria-hidden />
                    Payments
                  </h3>
                  <ul className="space-y-1 text-sm">
                    {detail.payments.map((p) => (
                      <li key={p.id} className="flex justify-between gap-3">
                        <span className="text-muted-foreground">
                          {formatDate(p.paidOn)} · {p.method.replaceAll("_", " ").toLowerCase()}
                          {p.reference ? ` · ${p.reference}` : ""}
                        </span>
                        <span className="tabular shrink-0 text-success-text">
                          {formatMoney(p.amountPaise)}
                        </span>
                      </li>
                    ))}
                    <li className="flex justify-between gap-3 border-t border-border pt-1">
                      <span className="font-medium">Outstanding</span>
                      <span className="tabular font-medium">
                        {formatMoney(detail.netPaise - detail.paidPaise)}
                      </span>
                    </li>
                  </ul>
                </section>
              ) : null}

              {/* ---------- the trace ---------- */}
              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <Calculator className="size-4 text-muted-foreground" aria-hidden />
                  How this was calculated
                </h3>
                <p className="mb-2 text-xs text-muted-foreground">
                  Every line the engine produced, in order. This is the record of how the
                  organisation&apos;s rules were applied to this person&apos;s month.
                </p>

                <ol className="space-y-1.5">
                  {detail.trace.map((line, i) => (
                    <li
                      key={`${line.stage}-${i}`}
                      className="rounded-md border border-border px-2.5 py-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Badge tone="outline">{STAGE_LABELS[line.stage] ?? line.stage}</Badge>
                          <span className="ml-1.5 font-medium">{line.label}</span>
                        </div>
                        {line.amountPaise !== 0 ? (
                          <span
                            className={`tabular shrink-0 font-medium ${
                              line.amountPaise < 0 ? "text-danger-text" : "text-foreground"
                            }`}
                          >
                            {line.amountPaise < 0 ? "−" : ""}
                            {formatMoney(Math.abs(line.amountPaise))}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
                        {line.formula}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "danger" | "warning";
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`tabular font-medium ${
          tone === "danger" ? "text-danger-text" : tone === "warning" ? "text-warning-text" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
