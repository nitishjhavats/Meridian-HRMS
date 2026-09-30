"use client";

import { useState } from "react";
import { BadgeIndianRupee, ChevronRight, Download, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { RequestFailed, api } from "@/lib/client/api";
import { openTabAfter } from "@/lib/client/openTab";
import { formatMoney } from "@/lib/utils";
import { PayrollBreakdown } from "@/app/(app)/payroll/[id]/PayrollBreakdown";

export interface SalaryRow {
  id: string;
  label: string;
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  paidPaise: number;
  settlement: string;
  payableDays: number;
  basisDays: number;
}

const TONE = {
  PAID: "success",
  PARTIALLY_PAID: "warning",
  UNPAID: "neutral",
} as const;

/**
 * The way to a sample payslip built from the reader's own salary.
 *
 * A plain link, because the route streams the PDF itself rather than handing
 * back a URL to fetch — there is nothing to prepare first, and no id to send.
 */
function SamplePayslipLink() {
  return (
    <Button asChild size="sm" variant="secondary">
      <a href="/api/payroll/slips/sample" target="_blank" rel="noreferrer noopener">
        <Eye className="size-4" aria-hidden />
        See a sample payslip
      </a>
    </Button>
  );
}

/**
 * An employee's own payslips.
 *
 * The same breakdown drawer the payroll admin sees — an employee who queries a
 * deduction should be able to read the arithmetic themselves rather than raise
 * a ticket to have it explained.
 *
 * `hasSalaryOnRecord` decides whether the sample is offered at all. Offering it
 * to somebody with no salary revision would put a button here that returns an
 * error, and the honest thing to say to that person is the sentence they need —
 * that HR has not recorded their salary yet — rather than a page of zeros.
 */
export function MySalaryList({
  rows,
  hasSalaryOnRecord,
}: {
  rows: SalaryRow[];
  hasSalaryOnRecord: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [slipError, setSlipError] = useState<string | null>(null);

  /**
   * The slip is rendered on first request, so this asks for the URL and then
   * opens it — rather than linking straight at a file that may not exist yet.
   */
  async function openSlip(itemId: string) {
    setDownloading(itemId);
    setSlipError(null);
    try {
      await openTabAfter(async () => (await api<{ url: string }>(`/api/payroll/slips/${itemId}`)).url);
    } catch (err) {
      setSlipError(
        err instanceof RequestFailed ? err.error.message : "That salary slip could not be prepared.",
      );
    } finally {
      setDownloading(null);
    }
  }

  // A dead end before: "No payslips yet" and nothing to do, for however many
  // weeks stood between somebody's first day and their first approved run.
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={BadgeIndianRupee}
        title="No payslips yet"
        description={
          hasSalaryOnRecord
            ? "They appear here once payroll for a month has been approved. Until then you can open a sample worked out from your own salary and this organisation's payroll rules. It is marked DEMO: nobody has been paid the figures on it."
            : "They appear here once payroll for a month has been approved. HR has not recorded a salary for you yet, so a sample uses an example figure and says so on the page — everything else on it is yours."
        }
        action={<SamplePayslipLink />}
      />
    );
  }

  return (
    <>
      <ul className="divide-y divide-border">
        {rows.map((row) => {
          const outstanding = row.netPaise - row.paidPaise;
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => setOpenId(row.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{row.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.payableDays} of {row.basisDays} days ·{" "}
                    {formatMoney(row.grossPaise)} gross
                    {row.deductionsPaise > 0
                      ? ` · −${formatMoney(row.deductionsPaise)} deductions`
                      : ""}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="tabular text-sm font-semibold">{formatMoney(row.netPaise)}</p>
                  <Badge tone={TONE[row.settlement as keyof typeof TONE] ?? "neutral"}>
                    {outstanding > 0 && row.paidPaise > 0
                      ? `${formatMoney(outstanding)} due`
                      : row.settlement.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                </div>

                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>

              <div className="px-4 pb-3">
                <button
                  type="button"
                  disabled={downloading === row.id}
                  onClick={() => openSlip(row.id)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <Download className="size-3.5" aria-hidden />
                  {downloading === row.id ? "Preparing…" : "Salary slip (PDF)"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {slipError ? (
        <p className="px-4 py-2 text-sm text-danger-text">{slipError}</p>
      ) : null}

      {/* Offered here too, not only on the empty state: "what would a full
          month look like" is the question somebody asks after a month that was
          prorated, and the answer is the same document. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          {hasSalaryOnRecord
            ? "A sample for a full month at your current salary, marked DEMO — nobody has been paid those figures."
            : "A sample for a full month, marked DEMO. HR has not recorded your salary yet, so the figure on it is an example and the page says so."}
        </p>
        <SamplePayslipLink />
      </div>

      <PayrollBreakdown itemId={openId} open={openId !== null} onClose={() => setOpenId(null)} />
    </>
  );
}
