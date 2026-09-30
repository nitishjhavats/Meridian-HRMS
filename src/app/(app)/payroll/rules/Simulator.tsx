"use client";

import { useState } from "react";
import { Calculator, FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequestFailed, api } from "@/lib/client/api";
import { formatDuration, formatMoney } from "@/lib/utils";

/**
 * The rule sandbox (spec §27).
 *
 * A hypothetical employee, run through the real engine. An admin can prove a
 * policy behaves before it is applied to anyone — and, when it does not, the
 * trace says exactly which rule produced the number they did not expect.
 */

interface TraceLine {
  stage: string;
  label: string;
  formula: string;
  amountPaise: number;
}

interface SimulationResult {
  netPaise: number;
  grossPaise: number;
  totalDeductionsPaise: number;
  advanceRecoveredPaise: number;
  ctcMonthlyPaise: number;
  days: { payableDays: number; basisDays: number; presentDays: number; lateCount: number };
  earnings: { code: string; label: string; amountPaise: number }[];
  deductions: { code: string; label: string; amountPaise: number }[];
  trace: TraceLine[];
  warnings: string[];
}

const STAGE_LABELS: Record<string, string> = {
  PERIOD: "Period",
  RESOLVE_SALARY: "Salary",
  PAYABLE_DAYS: "Payable days",
  PRORATE_EARNINGS: "Earnings",
  ABSENCE: "Absence",
  LATE_DEDUCTION: "Late",
  EARLY_LEAVE_DEDUCTION: "Early leave",
  UNPAID_LEAVE_DEDUCTION: "Unpaid leave",
  EXTRA_DAY_CREDIT: "Extra days",
  OVERTIME_CREDIT: "Overtime",
  ADJUSTMENTS: "Adjustments",
  STATUTORY_DEDUCTIONS: "Statutory",
  ADVANCE_RECOVERY: "Advance",
  ROUNDING: "Rounding",
  RESULT: "Result",
};

export function Simulator() {
  const now = new Date();
  const [form, setForm] = useState({
    ctcRupees: 50_000,
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() === 0 ? 12 : now.getUTCMonth(),
    presentDays: 25,
    halfDays: 1,
    absentDays: 0,
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    extraDays: 0,
    lateCount: 3,
    overtimeHours: 4,
    advanceRupees: 5_000,
  });

  const [result, setResult] = useState<SimulationResult | null>(null);
  const [unallocated, setUnallocated] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: number) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await api<{ result: SimulationResult; unallocatedDays: number }>(
        "/api/payroll/simulate",
        {
          method: "POST",
          body: {
            ctcMonthlyPaise: Math.round(form.ctcRupees * 100),
            year: form.year,
            month: form.month,
            presentDays: form.presentDays,
            halfDays: form.halfDays,
            absentDays: form.absentDays,
            paidLeaveDays: form.paidLeaveDays,
            unpaidLeaveDays: form.unpaidLeaveDays,
            extraDays: form.extraDays,
            lateCount: form.lateCount,
            overtimeMinutes: Math.round(form.overtimeHours * 60),
            advancePaise: Math.round(form.advanceRupees * 100),
          },
        },
      );
      setResult(response.result);
      setUnallocated(response.unallocatedDays);
    } catch (err) {
      setError(err instanceof RequestFailed ? err.error.message : "The simulation failed.");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  const number = (label: string, key: keyof typeof form, max = 31, decimals = 0) => (
    <Field label={label} htmlFor={key}>
      <NumberField
        id={key}
        min={0}
        max={max}
        decimals={decimals}
        value={form[key]}
        onValueChange={(v) => set(key, v ?? 0)}
        className="tabular"
      />
    </Field>
  );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2 lg:items-start">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FlaskConical className="size-4 text-primary" aria-hidden />
            Hypothetical employee
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Monthly salary (₹)" htmlFor="ctcRupees">
              <NumberField
                id="ctcRupees"
                min={0}
                decimals={2}
                value={form.ctcRupees}
                onValueChange={(v) => set("ctcRupees", v ?? 0)}
                className="tabular text-lg"
              />
            </Field>
            <Field label="Advance taken (₹)" htmlFor="advanceRupees">
              <NumberField
                id="advanceRupees"
                min={0}
                decimals={2}
                value={form.advanceRupees}
                onValueChange={(v) => set("advanceRupees", v ?? 0)}
                className="tabular"
              />
            </Field>
          </div>

          <div className="grid grid-cols-3 gap-3">
            {number("Present days", "presentDays")}
            {number("Half days", "halfDays")}
            {number("Absent days", "absentDays")}
            {number("Paid leave", "paidLeaveDays")}
            {number("Unpaid leave", "unpaidLeaveDays")}
            {number("Extra days", "extraDays")}
            {number("Late arrivals", "lateCount")}
            {number("Overtime (h)", "overtimeHours", 200, 2)}
          </div>

          <Button className="w-full" loading={busy} onClick={run}>
            <Calculator className="size-4" aria-hidden />
            Calculate
          </Button>

          {error ? <Alert tone="danger">{error}</Alert> : null}
          {unallocated > 0 ? (
            <Alert tone="warning">
              {unallocated} day(s) more than the month holds were described, so the extra were
              ignored.
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Result</CardTitle>
        </CardHeader>
        <CardContent>
          {!result ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Enter a scenario and calculate to see what your rules produce.
            </p>
          ) : (
            <div className="space-y-4">
              {result.warnings.length > 0 ? (
                <Alert tone="warning">
                  <ul className="list-inside list-disc">
                    {result.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}

              <div className="flex items-baseline justify-between rounded-lg bg-muted p-3">
                <div>
                  <p className="text-sm font-medium">Net payable</p>
                  <p className="text-xs text-muted-foreground">
                    {result.days.payableDays} of {result.days.basisDays} days payable
                  </p>
                </div>
                <p className="tabular text-2xl font-semibold">{formatMoney(result.netPaise)}</p>
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-sm font-medium">Earnings</p>
                  <ul className="space-y-0.5 text-sm">
                    {result.earnings.map((e) => (
                      <li key={e.code} className="flex justify-between gap-2">
                        <span className="truncate text-muted-foreground">{e.label}</span>
                        <span className="tabular shrink-0">{formatMoney(e.amountPaise)}</span>
                      </li>
                    ))}
                    <li className="flex justify-between gap-2 border-t border-border pt-0.5 font-medium">
                      <span>Gross</span>
                      <span className="tabular">{formatMoney(result.grossPaise)}</span>
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="mb-1 text-sm font-medium">Deductions</p>
                  {result.deductions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">None</p>
                  ) : (
                    <ul className="space-y-0.5 text-sm">
                      {result.deductions.map((d) => (
                        <li key={d.code} className="flex justify-between gap-2">
                          <span className="truncate text-muted-foreground">{d.label}</span>
                          <span className="tabular shrink-0 text-danger-text">
                            −{formatMoney(d.amountPaise)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              <div>
                <Button size="sm" variant="ghost" onClick={() => setShowTrace((v) => !v)}>
                  <Calculator className="size-4" aria-hidden />
                  {showTrace ? "Hide" : "Show"} the arithmetic
                </Button>

                {showTrace ? (
                  <ol className="mt-2 space-y-1.5">
                    {result.trace.map((line, i) => (
                      <li
                        key={i}
                        className="rounded-md border border-border px-2.5 py-2 text-xs"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span>
                            <Badge tone="outline">{STAGE_LABELS[line.stage] ?? line.stage}</Badge>
                            <span className="ml-1.5 font-medium">{line.label}</span>
                          </span>
                          {line.amountPaise !== 0 ? (
                            <span
                              className={`tabular shrink-0 font-medium ${
                                line.amountPaise < 0 ? "text-danger-text" : ""
                              }`}
                            >
                              {line.amountPaise < 0 ? "−" : ""}
                              {formatMoney(Math.abs(line.amountPaise))}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          {line.formula}
                        </p>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>

              {form.overtimeHours > 0 ? (
                <p className="text-xs text-muted-foreground">
                  Includes {formatDuration(form.overtimeHours * 60)} of overtime and{" "}
                  {result.days.lateCount} late arrival(s).
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
