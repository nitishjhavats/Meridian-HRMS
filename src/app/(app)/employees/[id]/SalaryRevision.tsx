"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BadgeIndianRupee } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert, LoadFailed, LoadingState } from "@/components/ui/states";
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
import { formatDate, formatMoney } from "@/lib/utils";
import { MONTH_NAMES, makeDate } from "@/domain/date";
import { resolveSalaryStructure } from "@/domain/payroll/policy";
import type { SalaryProfileView } from "@/services/payroll/salaryStructure";

/**
 * Setting somebody's salary.
 *
 * A raise is a **new revision**, never an edit of the old one: payroll for March
 * has to keep reading what it read in March, and the previous revision is closed
 * the day before this one starts rather than replaced.
 *
 * The breakdown below the CTC is computed with the real `resolveSalaryStructure`
 * against the rules in force on the date chosen — the same function and the same
 * component set the payroll engine will use — so what somebody is agreeing to is
 * visible before it is saved rather than on the payslip a month later.
 */

/** First of next month: where a salary revision almost always starts. */
function firstOfNextMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  return month === 12 ? makeDate(year + 1, 1, 1) : makeDate(year, month + 1, 1);
}

function firstOfMonthAfter(period: { year: number; month: number }): string {
  return period.month === 12
    ? makeDate(period.year + 1, 1, 1)
    : makeDate(period.year, period.month + 1, 1);
}

export function SalaryRevision({
  employeeId,
  name,
}: {
  employeeId: string;
  name: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SalaryProfileView | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [seeded, setSeeded] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [ctcRupees, setCtcRupees] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setView(null);
    setLoadedFor(null);
    setLoadError(null);
    setSeeded(false);
    setEffectiveFrom(firstOfNextMonth());
    setCtcRupees("");
    setNote("");
  }

  function start(next: boolean) {
    if (next) reset();
    setOpen(next);
  }

  /**
   * The component set comes from the payroll policy in force on the date chosen,
   * so changing the date reloads it. Cheap, and it is the only way the example
   * can promise to match the payslip.
   *
   * A failure is kept, not swallowed. This used to `.catch(() => null)` and
   * leave "Loading the salary structure…" on screen for ever, with Save never
   * enabling and nothing saying why -- an expired session and a bad stored
   * policy looked the same. The error is shown in the dialog with a retry, and
   * Save stays off while it stands, because the breakdown on screen (if any)
   * is for a date other than the one chosen.
   */
  useEffect(() => {
    if (!open || !effectiveFrom || effectiveFrom === loadedFor) return;
    setLoadedFor(effectiveFrom);
    setLoadError(null);
    void (async () => {
      let result: SalaryProfileView;
      try {
        result = await api<SalaryProfileView>(
          `/api/employees/${employeeId}/salary?on=${effectiveFrom}`,
        );
      } catch (error) {
        setLoadError(error);
        return;
      }
      setView(result);
      if (!seeded) {
        setSeeded(true);
        if (result.current) setCtcRupees(String(result.current.ctcMonthlyPaise / 100));
      }
    })();
  }, [open, effectiveFrom, loadedFor, seeded, employeeId]);

  /** Forget which date was loaded, so the effect above asks again. */
  function retryLoad() {
    setLoadError(null);
    setLoadedFor(null);
  }

  const ctcPaise = Math.max(0, Math.round((Number(ctcRupees) || 0) * 100));
  const resolved =
    view && ctcPaise > 0 && view.issues.length === 0
      ? resolveSalaryStructure(ctcPaise, view.components, view.percentBase)
      : null;

  const minStart = view?.lockedThrough ? firstOfMonthAfter(view.lockedThrough) : undefined;
  // Not blocked: re-recording the same CTC is how a breakdown is refrozen after
  // the component set itself changes. Worth saying out loud, not worth refusing.
  const sameAmount = ctcPaise > 0 && view?.current?.ctcMonthlyPaise === ctcPaise;

  async function save() {
    setBusy(true);
    const next = await mutate<SalaryProfileView>(
      () =>
        api(`/api/employees/${employeeId}/salary`, {
          method: "POST",
          body: {
            ctcMonthlyPaise: ctcPaise,
            effectiveFrom,
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      {
        success: `${name} is on ${formatMoney(ctcPaise)} a month from ${effectiveFrom}.`,
        error: "Nothing was saved",
      },
    );
    setBusy(false);
    if (next) {
      setOpen(false);
      router.refresh();
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => start(true)}>
        <BadgeIndianRupee className="size-4" aria-hidden />
        Set salary
      </Button>

      <Dialog open={open} onOpenChange={start}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Set {name}&rsquo;s salary</DialogTitle>
            <DialogDescription>
              Recorded as a new revision from the date you choose. The previous one is closed the
              day before, so payroll already run keeps the figures it was run on.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {loadError !== null ? (
              <LoadFailed
                compact
                error={loadError}
                what="The salary structure"
                onRetry={retryLoad}
              />
            ) : null}

            {view === null ? (
              loadError === null ? (
                <LoadingState label="Loading the salary structure…" />
              ) : null
            ) : (
              <>
                {view.issues.length > 0 ? (
                  <Alert tone="danger" title="The salary structure has to be fixed first">
                    <ul className="list-inside list-disc">
                      {view.issues.map((issue, i) => (
                        <li key={i}>{issue.message}</li>
                      ))}
                    </ul>
                    <Link href="/settings/salary" className="mt-1 inline-block underline">
                      Open the salary structure
                    </Link>
                  </Alert>
                ) : null}

                {view.lockedThrough ? (
                  <Alert tone="info" title="Locked payroll">
                    {MONTH_NAMES[view.lockedThrough.month - 1]} {view.lockedThrough.year} payroll is
                    locked and paid, so a revision cannot start before {formatDate(minStart)}.
                  </Alert>
                ) : null}

                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                  <Field
                    label="Monthly CTC (₹)"
                    htmlFor="salary-ctc"
                    required
                    hint={
                      sameAmount
                        ? "The same as the salary in force. This still writes a new revision."
                        : view.current
                          ? `Currently ${formatMoney(view.current.ctcMonthlyPaise)}.`
                          : "No salary has been recorded for this person yet."
                    }
                  >
                    <Input
                      id="salary-ctc"
                      type="number"
                      min={0}
                      step="1"
                      value={ctcRupees}
                      onChange={(e) => setCtcRupees(e.target.value)}
                    />
                  </Field>

                  <Field
                    label="Effective from"
                    htmlFor="salary-from"
                    required
                    hint={
                      view.employee.joiningDate
                        ? `Joined on ${formatDate(view.employee.joiningDate)}.`
                        : "The first day this salary applies."
                    }
                  >
                    <Input
                      id="salary-from"
                      type="date"
                      value={effectiveFrom}
                      min={minStart}
                      onChange={(e) => setEffectiveFrom(e.target.value)}
                    />
                  </Field>
                </div>

                <Field
                  label="Note"
                  htmlFor="salary-note"
                  hint="Why the change. Kept against the revision for whoever reads it later."
                >
                  <Textarea
                    id="salary-note"
                    value={note}
                    placeholder="Annual review, effective from the new financial year"
                    onChange={(e) => setNote(e.target.value)}
                  />
                </Field>

                {resolved ? (
                  <div className="rounded-md border border-border p-3">
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      What this pays, from {formatDate(effectiveFrom)}
                    </p>
                    <dl className="divide-y divide-border text-sm">
                      {resolved.earnings.map((line) => (
                        <div
                          key={line.component.code}
                          className="flex items-baseline justify-between gap-3 py-1.5"
                        >
                          <div className="min-w-0">
                            <dt className="truncate">{line.component.name}</dt>
                            <dd className="truncate text-xs text-muted-foreground">
                              {line.formula}
                            </dd>
                          </div>
                          <dd className="tabular shrink-0">{formatMoney(line.amountPaise)}</dd>
                        </div>
                      ))}
                      <div className="flex items-baseline justify-between gap-3 py-1.5 font-semibold">
                        <dt>Gross</dt>
                        <dd className="tabular">{formatMoney(resolved.grossPaise)}</dd>
                      </div>
                    </dl>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Before attendance, unpaid leave, advances and statutory deductions, which the
                      monthly payroll run applies on top.
                    </p>
                  </div>
                ) : null}

                {view.history.length > 0 ? (
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                      Revision history
                    </p>
                    <ul className="divide-y divide-border text-sm">
                      {view.history.map((revision) => (
                        <li
                          key={revision.id}
                          className="flex items-baseline justify-between gap-3 py-1.5"
                        >
                          <span>
                            {formatDate(revision.effectiveFrom)} →{" "}
                            {revision.effectiveTo ? formatDate(revision.effectiveTo) : "now"}
                            {revision.note ? (
                              <span className="block text-xs text-muted-foreground">
                                {revision.note}
                              </span>
                            ) : null}
                          </span>
                          <span className="tabular shrink-0">
                            {formatMoney(revision.ctcMonthlyPaise)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </DialogBody>

          <DialogFooter>
            <Button
              loading={busy}
              disabled={
                busy ||
                view === null ||
                loadError !== null ||
                view.issues.length > 0 ||
                ctcPaise <= 0 ||
                effectiveFrom.length !== 10
              }
              onClick={() => void save()}
            >
              Save revision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
