"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { formatMoney } from "@/lib/utils";

/**
 * One-off changes to a person's pay for one month.
 *
 * The important thing this screen has to be honest about is that adding an
 * adjustment does not change the figures on the run. It changes the *input*: the
 * engine reads it on the next calculation, and until then the numbers on this
 * page are stale. Saying so is the difference between a feature that works and
 * one that quietly disagrees with the payslip.
 *
 * Which is why nothing can be added once the run is approved. Recalculating is
 * refused from APPROVED, and so is reopening -- that is for a locked run -- so
 * an adjustment added there could never reach a payslip, and the toast that
 * said "recalculate the run to apply it" named a button that was not on the
 * page. From APPROVED onwards the dialog is a view: it lists what is there and
 * says the one thing that actually works, which is to lock the run and reopen
 * it as a new revision (the adjustments are carried onto it).
 */

interface Adjustment {
  id: string;
  label: string;
  kind: string;
  amountPaise: number;
  reason: string | null;
}

/** Only a run that can still be recalculated can take a new input. */
function isEditable(runStatus: string): boolean {
  return runStatus === "DRAFT" || runStatus === "CALCULATED";
}

export function Adjustments({
  runId,
  employeeId,
  employeeName,
  runStatus,
}: {
  runId: string;
  employeeId: string;
  employeeName: string;
  runStatus: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Adjustment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<"EARNING" | "DEDUCTION">("EARNING");
  const [rupees, setRupees] = useState("");
  const [reason, setReason] = useState("");

  const editable = isEditable(runStatus);
  const amountPaise = Math.round(Number(rupees.replace(/[^0-9.]/g, "")) * 100);

  async function load() {
    const result = await api<{ adjustments: Adjustment[] }>(
      `/api/payroll/adjustments?runId=${runId}&employeeId=${employeeId}`,
    ).catch(() => null);
    if (result) setRows(result.adjustments);
    setLoaded(true);
  }

  useEffect(() => {
    if (open && !loaded) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function add() {
    setBusy(true);
    const result = await mutate(
      () =>
        api("/api/payroll/adjustments", {
          method: "POST",
          body: {
            payrollRunId: runId,
            employeeId,
            label: label.trim(),
            kind,
            amountPaise,
            reason: reason.trim() || undefined,
          },
        }),
      { success: "Added. Recalculate the run to apply it.", error: "It was not added" },
    );
    setBusy(false);
    if (result) {
      setLabel("");
      setRupees("");
      setReason("");
      await load();
      router.refresh();
    }
  }

  async function remove(adjustment: Adjustment) {
    setBusy(true);
    const done = await mutate(
      () => api(`/api/payroll/adjustments/${adjustment.id}`, { method: "DELETE" }),
      { success: "Removed. Recalculate the run to apply it.", error: "It was not removed" },
    );
    setBusy(false);
    if (done !== null) {
      await load();
      router.refresh();
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* A verb while it can do something; a noun once it can only show. */}
        <Button variant="ghost" size="sm">
          <SlidersHorizontal className="size-4" aria-hidden />
          {editable ? "Adjust" : "Adjustments"}
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editable ? <>Adjust {employeeName}&rsquo;s pay</> : <>{employeeName}&rsquo;s adjustments</>}
          </DialogTitle>
          <DialogDescription>
            A one-off change for this month only. It does not alter their salary structure.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {editable ? (
            <Alert tone="info" title="Recalculate to apply">
              An adjustment is an input to the engine. The figures on this run stay as they are
              until it is recalculated.
            </Alert>
          ) : runStatus === "APPROVED" ? (
            <Alert tone="warning" title="This run is approved, so its figures are fixed">
              Nothing added now could be applied: an approved run is not recalculated. To change
              anything, lock the run, then reopen it as a new revision &mdash; the adjustments
              listed here are carried onto the revision, and new ones can be added there before
              it is calculated.
            </Alert>
          ) : runStatus === "LOCKED" ? (
            <Alert tone="warning" title="This run is locked">
              What was paid cannot be changed. Reopen the run as a new revision &mdash; the
              adjustments listed here are carried onto it.
            </Alert>
          ) : (
            <Alert tone="warning" title="This run cannot be changed">
              Nothing can be added to a run in this state.
            </Alert>
          )}

          {rows.length > 0 ? (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {rows.map((row) => (
                <li key={row.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{row.label}</span>
                    {row.reason ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.reason}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`tabular text-sm font-medium ${
                      row.kind === "DEDUCTION" ? "text-danger-text" : "text-success-text"
                    }`}
                  >
                    {row.kind === "DEDUCTION" ? "−" : "+"}
                    {formatMoney(row.amountPaise)}
                  </span>
                  {editable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Remove ${row.label}`}
                      onClick={() => void remove(row)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : loaded ? (
            <p className="text-sm text-muted-foreground">Nothing adjusted this month.</p>
          ) : null}

          {editable ? (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                <Field label="What is it" htmlFor="adjLabel" required>
                  <Input
                    id="adjLabel"
                    placeholder="Festival bonus"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </Field>
                <Field label="Amount" htmlFor="adjAmount" hint="In rupees." required>
                  <Input
                    id="adjAmount"
                    inputMode="decimal"
                    placeholder="5000"
                    value={rupees}
                    onChange={(e) => setRupees(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="Which way" htmlFor="adjKind">
                <Select
                  id="adjKind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                >
                  <option value="EARNING">Add to their pay</option>
                  <option value="DEDUCTION">Take off their pay</option>
                </Select>
              </Field>

              <Field label="Reason" htmlFor="adjReason" hint="Shown in the audit log.">
                <Input
                  id="adjReason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {editable ? (
            <Button
              loading={busy}
              disabled={label.trim().length < 2 || !(amountPaise > 0) || busy}
              onClick={() => void add()}
            >
              <Plus className="size-4" aria-hidden />
              Add {amountPaise > 0 ? formatMoney(amountPaise) : ""}
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
