"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Calculator, CheckCircle2, Download, FileText, Lock, Unlock } from "lucide-react";
import { toast } from "@/components/ui/toast";
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
import { formatMoney, pluralise } from "@/lib/utils";

/**
 * Moving a run through its lifecycle.
 *
 * Each button appears only in the state that allows it, and the destructive one
 * — reopening a locked run — explains that it creates a new revision rather than
 * editing history, because that is the part people get wrong.
 */
export function RunControls({
  runId,
  status,
  label,
  employees,
  canRun,
  canApprove,
  canLock,
  canUnlock,
  canDisburse,
}: {
  runId: string;
  status: string;
  label: string;
  employees: number;
  canRun: boolean;
  canApprove: boolean;
  canLock: boolean;
  canUnlock: boolean;
  canDisburse: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reason, setReason] = useState("");
  const [report, setReport] = useState<{
    employees: number;
    skipped: { name: string; reason: string }[];
    totals: { netPaise: number };
    warnings: number;
  } | null>(null);

  async function act(action: "calculate" | "approve" | "lock") {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ report?: typeof report }>(`/api/payroll/runs/${runId}/action`, {
          method: "POST",
          body: { action },
        }),
      {
        success:
          action === "calculate"
            ? "Payroll calculated."
            : action === "approve"
              ? "Payroll approved."
              : `${label} payroll is locked.`,
      },
    );
    setBusy(false);
    if (result) {
      if (action === "calculate" && result.report) setReport(result.report);
      router.refresh();
    }
  }

  /**
   * Renders every slip in the run in one go.
   *
   * The route has existed since slips were built and nothing ever called it, so
   * each payslip was only created when somebody happened to open it. That is
   * fine for one person and useless for a payroll officer with fifty.
   */
  async function generateSlips() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ generated: number }>(`/api/payroll/runs/${runId}/slips`, { method: "POST" }),
      { error: "The slips were not generated" },
    );
    setBusy(false);
    if (result) {
      toast.success(
        result.generated === 1
          ? "1 salary slip generated."
          : `${result.generated} salary slips generated.`,
      );
      router.refresh();
    }
  }

  async function reopen() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ run: { id: string } }>(`/api/payroll/runs/${runId}/action`, {
          method: "POST",
          body: { action: "reopen", reason: reason.trim() },
        }),
      { success: "A new revision was created, adjustments included. The locked run is unchanged." },
    );
    setBusy(false);
    if (result) {
      setReopening(false);
      setReason("");
      router.push(`/payroll/${result.run.id}`);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {canRun && (status === "DRAFT" || status === "CALCULATED") ? (
        <Button loading={busy} onClick={() => act("calculate")}>
          <Calculator className="size-4" aria-hidden />
          {status === "DRAFT" ? "Calculate payroll" : "Recalculate"}
        </Button>
      ) : null}

      {canApprove && status === "CALCULATED" ? (
        <Button variant="success" loading={busy} onClick={() => act("approve")}>
          <CheckCircle2 className="size-4" aria-hidden />
          Approve
        </Button>
      ) : null}

      {canLock && status === "APPROVED" ? (
        <Button loading={busy} onClick={() => act("lock")}>
          <Lock className="size-4" aria-hidden />
          Lock payroll
        </Button>
      ) : null}

      {/* Recalculate disappears at approval and nothing used to say why -- or
          what to do instead. The service refuses to recalculate an approved
          run and refuses to reopen anything but a locked one, so the only way
          to change a figure from here is forward, through the lock. */}
      {canRun && status === "APPROVED" ? (
        <p className="basis-full text-xs text-muted-foreground">
          The figures are fixed once approved. To change anything &mdash; attendance, an
          adjustment, a salary &mdash; lock the run, then reopen it as a new revision.
        </p>
      ) : null}

      {canUnlock && status === "LOCKED" ? (
        <Button variant="outline" onClick={() => setReopening(true)}>
          <Unlock className="size-4" aria-hidden />
          Reopen as new revision
        </Button>
      ) : null}

      {canRun && employees > 0 && (status === "APPROVED" || status === "LOCKED") ? (
        <Button variant="outline" loading={busy} onClick={generateSlips}>
          <FileText className="size-4" aria-hidden />
          Generate all slips
        </Button>
      ) : null}

      {canDisburse && employees > 0 && (status === "APPROVED" || status === "LOCKED") ? (
        <Button asChild variant="outline">
          <a href={`/api/payroll/runs/${runId}/bank-advice`}>
            <Download className="size-4" aria-hidden />
            Bank advice CSV
          </a>
        </Button>
      ) : null}

      {/* ---------- calculation report ---------- */}
      <Dialog open={report !== null} onOpenChange={(open) => !open && setReport(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label} calculated</DialogTitle>
            <DialogDescription>
              {pluralise(report?.employees ?? 0, "employee")} ·{" "}
              {formatMoney(report?.totals.netPaise ?? 0)} net
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {report?.warnings ? (
              <Alert tone={report.warnings > 0 ? "warning" : "success"}>
                {report.warnings > 0
                  ? `${pluralise(report.warnings, "warning")} across the run — open a payslip to see which.`
                  : "No warnings."}
              </Alert>
            ) : null}

            {report && report.skipped.length > 0 ? (
              <div>
                <p className="text-sm font-medium">
                  {pluralise(report.skipped.length, "employee was", "employees were")} left out
                </p>
                <ul className="mt-1.5 space-y-1 text-sm text-muted-foreground">
                  {report.skipped.map((s) => (
                    <li key={s.name}>
                      <span className="text-foreground">{s.name}</span> — {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => setReport(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- reopen ---------- */}
      <Dialog open={reopening} onOpenChange={setReopening}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reopen {label}?</DialogTitle>
            <DialogDescription>This does not edit the locked run.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Alert tone="info" title="What actually happens">
              The locked run stays exactly as it is — it is the record of what was paid. A new
              revision is created alongside it for you to recalculate. Payments already recorded
              stay against the original. One-off adjustments — a bonus, a recovery — are copied
              onto the revision so they are not lost; remove any that should no longer apply
              before recalculating.
            </Alert>
            <Field
              label="Why are you reopening it?"
              htmlFor="reason"
              required
              hint="Written to the audit log."
            >
              <Textarea
                id="reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Attendance was corrected for two employees after locking"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReopening(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!reason.trim()} onClick={reopen}>
              Create revision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
