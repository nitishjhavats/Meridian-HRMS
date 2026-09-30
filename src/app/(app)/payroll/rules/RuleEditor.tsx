"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequestFailed, api, mutate } from "@/lib/client/api";
import type { PayrollPolicy } from "@/domain/payroll/types";

/**
 * The payroll rules, edited by hand.
 *
 * **Why this exists.** Every non-statutory rule in this product was editable
 * only by asking an AI to rewrite the whole policy. An organisation without an
 * OpenRouter key — which is most of them, and all of them on day one — was
 * permanently stuck on the shipped defaults for late deductions, overtime, the
 * half-day factor, the payable-days basis, rounding, advance recovery, extra-day
 * handling and the leave booleans. The API has accepted a hand-written policy
 * since it was built; no client had ever sent one.
 *
 * It sits *beside* the AI drafter rather than replacing it. The two do different
 * jobs: the drafter turns a sentence into a starting point, and this changes one
 * number when somebody already knows which number.
 *
 * **What is not here.** Salary components live on the salary structure screen
 * and statutory deductions on the panel above, both of which are better than a
 * row in a long form. This is everything else — which is exactly the part that
 * had no form at all.
 *
 * Nothing is saved without a date it takes effect from, because payroll already
 * run for an earlier month must keep the rules it was run under.
 */

interface Issue {
  path: string;
  message: string;
}

const PAYABLE_DAYS: { value: PayrollPolicy["payableDaysBasis"]; label: string }[] = [
  { value: "CALENDAR_DAYS", label: "Calendar days in the month" },
  { value: "FIXED_30", label: "Always 30" },
  { value: "WORKING_DAYS", label: "Working days only" },
  { value: "WORKING_DAYS_PLUS_PAID_OFF", label: "Working days plus paid week offs and holidays" },
];

export function RuleEditor({
  initial,
  leaveTypes,
}: {
  initial: PayrollPolicy;
  /**
   * The organisation's own leave types, for the comp-off field.
   *
   * It was a free-text box, and a code that matches no leave type does not
   * fail: `creditCompOff` looks it up at lock time, finds nothing, skips the
   * credit and stamps it as done anyway. Somebody who worked a rest day gets
   * nothing and no screen ever says why. A list cannot be typed wrong.
   */
  leaveTypes: { code: string; name: string }[];
}) {
  const router = useRouter();
  const [policy, setPolicy] = useState<PayrollPolicy>(initial);
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);

  const dirty = JSON.stringify(policy) !== JSON.stringify(initial);

  /** Edits one branch of the policy without losing the rest of it. */
  function patch<K extends keyof PayrollPolicy>(key: K, value: PayrollPolicy[K]) {
    setPolicy((p) => ({ ...p, [key]: value }));
  }

  async function save() {
    setBusy(true);
    setIssues([]);
    try {
      // `activate` validates against the same schema the AI path uses and runs
      // the same conflict analysis, so a hand-edited policy cannot reach
      // payroll by a laxer route than a generated one.
      await api("/api/payroll/rules", {
        method: "POST",
        body: {
          action: "activate",
          policy,
          effectiveFrom,
          note: note.trim() || "Edited by hand",
        },
      });
      setBusy(false);
      setOpen(false);
      router.refresh();
    } catch (error) {
      setBusy(false);
      if (error instanceof RequestFailed) {
        const details = error.error.details as { issues?: Issue[] } | undefined;
        setIssues(details?.issues ?? [{ path: "", message: error.error.message }]);
      } else {
        setIssues([{ path: "", message: "We could not reach the server." }]);
      }
    }
  }

  if (!open) {
    /**
     * A panel, not a small outline button.
     *
     * This is where every non-statutory rule in the product is set, and it was
     * one `variant="outline"` button under a wall of read-only text -- so it
     * read as a footnote to the rules rather than the way to change them.
     */
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="min-w-0">
            <p className="text-base font-semibold">Edit the rules by hand</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The month, lateness, absence, overtime, rest days and rounding &mdash; everything
              payroll calculates from, without asking the AI to rewrite it.
            </p>
          </div>
          <Button size="lg" onClick={() => setOpen(true)}>
            <Pencil className="size-4" aria-hidden />
            Edit the rules
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit the rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {issues.length > 0 ? (
          <Alert tone="danger" title="Nothing was saved">
            <ul className="mt-1 space-y-0.5">
              {issues.map((issue, i) => (
                <li key={`${issue.path}-${i}`} className="text-xs">
                  {issue.path ? <span className="font-mono">{issue.path}: </span> : null}
                  {issue.message}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {/* ---------- the month ---------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">The month</h3>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field
              label="A full month is"
              htmlFor="payableDaysBasis"
              hint="What one day of pay is divided out of."
            >
              <Select
                id="payableDaysBasis"
                value={policy.payableDaysBasis}
                onChange={(e) =>
                  patch("payableDaysBasis", e.target.value as PayrollPolicy["payableDaysBasis"])
                }
              >
                {PAYABLE_DAYS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="A half day counts as"
              htmlFor="halfDayFactor"
              hint="0.5 is half a day's pay. 0 pays nothing for one."
            >
              <NumberField
                id="halfDayFactor"
                min={0}
                max={1}
                decimals={2}
                className="tabular"
                value={policy.attendance.halfDayFactor}
                onValueChange={(v) =>
                  patch("attendance", {
                    ...policy.attendance,
                    halfDayFactor: v ?? 0,
                  })
                }
              />
            </Field>
          </div>
        </section>

        {/* ---------- lateness ---------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Being late</h3>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field label="Rule" htmlFor="lateType">
              <Select
                id="lateType"
                value={policy.attendance.late.type}
                onChange={(e) => {
                  const type = e.target.value;
                  // Each shape carries different fields, so switching builds a
                  // whole valid rule rather than leaving half of the old one on.
                  const late =
                    type === "NONE"
                      ? ({ type: "NONE" } as const)
                      : type === "PER_OCCURRENCE"
                        ? ({ type: "PER_OCCURRENCE", freeCount: 0, amountPaise: 0 } as const)
                        : type === "HALF_DAY_PER_N"
                          ? ({ type: "HALF_DAY_PER_N", n: 3, freeCount: 0 } as const)
                          : ({ type: "PRORATA_MINUTES", freeMinutes: 0 } as const);
                  patch("attendance", { ...policy.attendance, late });
                }}
              >
                <option value="NONE">No deduction</option>
                <option value="PER_OCCURRENCE">A fixed amount each time</option>
                <option value="HALF_DAY_PER_N">Half a day for every N times</option>
                <option value="PRORATA_MINUTES">Pro-rata on the minutes lost</option>
              </Select>
            </Field>

            {policy.attendance.late.type === "PER_OCCURRENCE" ? (
              <>
                <Field label="Free each month" htmlFor="lateFree">
                  <NumberField
                    id="lateFree"
                    min={0}
                    className="tabular"
                    value={policy.attendance.late.freeCount}
                    onValueChange={(v) =>
                      patch("attendance", {
                        ...policy.attendance,
                        late: {
                          type: "PER_OCCURRENCE",
                          freeCount: v ?? 0,
                          amountPaise:
                            policy.attendance.late.type === "PER_OCCURRENCE"
                              ? policy.attendance.late.amountPaise
                              : 0,
                        },
                      })
                    }
                  />
                </Field>
                <Field label="Deducted each time (₹)" htmlFor="lateAmount">
                  <NumberField
                    id="lateAmount"
                    min={0}
                    decimals={2}
                    className="tabular"
                    value={policy.attendance.late.amountPaise / 100}
                    onValueChange={(v) =>
                      patch("attendance", {
                        ...policy.attendance,
                        late: {
                          type: "PER_OCCURRENCE",
                          freeCount:
                            policy.attendance.late.type === "PER_OCCURRENCE"
                              ? policy.attendance.late.freeCount
                              : 0,
                          amountPaise: Math.round((v ?? 0) * 100),
                        },
                      })
                    }
                  />
                </Field>
              </>
            ) : null}

            {policy.attendance.late.type === "HALF_DAY_PER_N" ? (
              <>
                <Field label="Every N late marks" htmlFor="lateN">
                  <NumberField
                    id="lateN"
                    min={1}
                    className="tabular"
                    value={policy.attendance.late.n}
                    onValueChange={(v) =>
                      patch("attendance", {
                        ...policy.attendance,
                        late: {
                          type: "HALF_DAY_PER_N",
                          n: v ?? 1,
                          freeCount:
                            policy.attendance.late.type === "HALF_DAY_PER_N"
                              ? policy.attendance.late.freeCount
                              : 0,
                        },
                      })
                    }
                  />
                </Field>
                <Field label="Free each month" htmlFor="lateNFree">
                  <NumberField
                    id="lateNFree"
                    min={0}
                    className="tabular"
                    value={policy.attendance.late.freeCount}
                    onValueChange={(v) =>
                      patch("attendance", {
                        ...policy.attendance,
                        late: {
                          type: "HALF_DAY_PER_N",
                          n:
                            policy.attendance.late.type === "HALF_DAY_PER_N"
                              ? policy.attendance.late.n
                              : 3,
                          freeCount: v ?? 0,
                        },
                      })
                    }
                  />
                </Field>
              </>
            ) : null}

            {policy.attendance.late.type === "PRORATA_MINUTES" ? (
              <Field label="Minutes forgiven" htmlFor="lateMinutes">
                <NumberField
                  id="lateMinutes"
                  min={0}
                  className="tabular"
                  value={policy.attendance.late.freeMinutes}
                  onValueChange={(v) =>
                    patch("attendance", {
                      ...policy.attendance,
                      late: { type: "PRORATA_MINUTES", freeMinutes: v ?? 0 },
                    })
                  }
                />
              </Field>
            ) : null}
          </div>
        </section>

        {/* ---------- overtime ---------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Overtime</h3>
          <div className="flex items-center gap-3 rounded-lg border border-border p-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Pay for overtime</p>
              <p className="text-xs text-muted-foreground">
                Off means extra hours are recorded but never paid.
              </p>
            </div>
            <Switch
              checked={policy.overtime.enabled}
              aria-label="Pay for overtime"
              onCheckedChange={(on) => patch("overtime", { ...policy.overtime, enabled: on })}
            />
          </div>

          {policy.overtime.enabled ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <Field label="Rate" htmlFor="otType">
                <Select
                  id="otType"
                  value={policy.overtime.rate.type}
                  onChange={(e) =>
                    patch("overtime", {
                      ...policy.overtime,
                      rate:
                        e.target.value === "MULTIPLIER"
                          ? { type: "MULTIPLIER", value: 1.5 }
                          : { type: "FLAT_PER_HOUR", amountPaise: 0 },
                    })
                  }
                >
                  <option value="MULTIPLIER">A multiple of the hourly rate</option>
                  <option value="FLAT_PER_HOUR">A flat amount per hour</option>
                </Select>
              </Field>

              {policy.overtime.rate.type === "MULTIPLIER" ? (
                <Field label="Multiplier" htmlFor="otValue" hint="1.5 is time and a half.">
                  <NumberField
                    id="otValue"
                    min={0}
                    decimals={2}
                    className="tabular"
                    value={policy.overtime.rate.value}
                    onValueChange={(v) =>
                      patch("overtime", {
                        ...policy.overtime,
                        rate: { type: "MULTIPLIER", value: v ?? 0 },
                      })
                    }
                  />
                </Field>
              ) : (
                <Field label="Per hour (₹)" htmlFor="otFlat">
                  <NumberField
                    id="otFlat"
                    min={0}
                    decimals={2}
                    className="tabular"
                    value={policy.overtime.rate.amountPaise / 100}
                    onValueChange={(v) =>
                      patch("overtime", {
                        ...policy.overtime,
                        rate: {
                          type: "FLAT_PER_HOUR",
                          amountPaise: Math.round((v ?? 0) * 100),
                        },
                      })
                    }
                  />
                </Field>
              )}

              <Field label="Hourly rate comes from" htmlFor="otBasis">
                <Select
                  id="otBasis"
                  value={policy.overtime.hourlyBasis}
                  onChange={(e) =>
                    patch("overtime", {
                      ...policy.overtime,
                      hourlyBasis: e.target.value as PayrollPolicy["overtime"]["hourlyBasis"],
                    })
                  }
                >
                  <option value="CTC_PER_HOUR">The whole monthly salary</option>
                  <option value="BASIC_PER_HOUR">Basic only</option>
                </Select>
              </Field>

              <Field
                label="Most payable minutes a month"
                htmlFor="otCap"
                hint="0 means no cap."
              >
                <NumberField
                  id="otCap"
                  min={0}
                  className="tabular"
                  value={policy.overtime.maxPayableMinutesPerMonth}
                  onValueChange={(v) =>
                    patch("overtime", {
                      ...policy.overtime,
                      maxPayableMinutesPerMonth: v ?? 0,
                    })
                  }
                />
              </Field>
            </div>
          ) : null}
        </section>

        {/* ---------- leave ---------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">What is paid</h3>
          <div className="space-y-2">
            {(
              [
                ["paidLeaveIsPayable", "Approved paid leave is paid"],
                ["unpaidLeaveDeducted", "Unpaid leave is deducted"],
                ["weekOffPayable", "Week offs are paid"],
                ["holidayPayable", "Holidays are paid"],
              ] as const
            ).map(([key, label]) => (
              <div
                key={key}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <p className="min-w-0 flex-1 text-sm">{label}</p>
                <Switch
                  checked={policy.leave[key]}
                  aria-label={label}
                  onCheckedChange={(on) => patch("leave", { ...policy.leave, [key]: on })}
                />
              </div>
            ))}
          </div>
        </section>

        {/* ---------- rest days ---------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Week offs and holidays</h3>

          {/**
            * `extraDay` has been fully implemented in the engine since it was
            * written and editable **nowhere** -- only the AI rule builder could
            * set it. So "worked on a week off, give them a day's overtime" was a
            * rule the product could calculate and no administrator could switch
            * on.
            */}
          <Field
            label="Somebody works on a week off or a holiday"
            htmlFor="extraDayMode"
            hint="What that day is worth on the payslip."
          >
            <Select
              id="extraDayMode"
              value={policy.extraDay.mode}
              onChange={(e) => {
                const mode = e.target.value as PayrollPolicy["extraDay"]["mode"];
                patch(
                  "extraDay",
                  mode === "MULTIPLIER"
                    ? { mode, multiplier: 2 }
                    : mode === "COMP_OFF"
                      ? { mode, leaveTypeCode: "COMP_OFF", daysPerExtraDay: 1 }
                      : { mode },
                );
              }}
            >
              <option value="NORMAL_DAY">Counted as an ordinary working day</option>
              <option value="MULTIPLIER">Paid at a multiple of a day&rsquo;s salary</option>
              <option value="OVERTIME_RATE">Paid through overtime, by the hour</option>
              <option value="COMP_OFF">No cash &mdash; credited as compensatory off</option>
            </Select>
          </Field>

          {policy.extraDay.mode === "MULTIPLIER" ? (
            <Field label="Times a day&rsquo;s salary" htmlFor="extraDayMultiplier">
              <NumberField
                id="extraDayMultiplier"
                min={0}
                max={10}
                decimals={2}
                className="tabular"
                value={policy.extraDay.multiplier}
                onValueChange={(v) => patch("extraDay", { mode: "MULTIPLIER", multiplier: v ?? 1 })}
              />
            </Field>
          ) : null}

          {policy.extraDay.mode === "COMP_OFF" ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <Field
                label="Credited to leave type"
                htmlFor="compOffCode"
                hint={
                  leaveTypes.length === 0
                    ? "There are no leave types yet. Add one under Settings first."
                    : undefined
                }
              >
                <Select
                  id="compOffCode"
                  value={policy.extraDay.leaveTypeCode}
                  onChange={(e) =>
                    patch("extraDay", {
                      mode: "COMP_OFF",
                      leaveTypeCode: e.target.value,
                      daysPerExtraDay:
                        policy.extraDay.mode === "COMP_OFF" ? policy.extraDay.daysPerExtraDay : 1,
                    })
                  }
                >
                  {leaveTypes.map((type) => (
                    <option key={type.code} value={type.code}>
                      {type.name} ({type.code})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Days credited per extra day" htmlFor="compOffDays">
                <NumberField
                  id="compOffDays"
                  min={0}
                  max={5}
                  decimals={2}
                  className="tabular"
                  value={policy.extraDay.daysPerExtraDay}
                  onValueChange={(v) =>
                    patch("extraDay", {
                      mode: "COMP_OFF",
                      leaveTypeCode:
                        policy.extraDay.mode === "COMP_OFF"
                          ? policy.extraDay.leaveTypeCode
                          : "COMP_OFF",
                      daysPerExtraDay: v ?? 1,
                    })
                  }
                />
              </Field>
            </div>
          ) : null}

          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field
              label="Week offs owed each month"
              htmlFor="weekOffQuota"
              hint="Leave it empty to give whatever the weekly-off pattern gives. This is the company-wide number: a designation or a person can override this."
            >
              <NumberField
                id="weekOffQuota"
                min={0}
                max={31}
                className="tabular"
                value={policy.weekOff.quotaPerMonth}
                onValueChange={(v) => patch("weekOff", { ...policy.weekOff, quotaPerMonth: v })}
              />
            </Field>
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
            <p className="min-w-0 flex-1 text-sm">Those week offs are paid</p>
            <Switch
              checked={policy.weekOff.paid}
              aria-label="Week offs within the quota are paid"
              onCheckedChange={(on) => patch("weekOff", { ...policy.weekOff, paid: on })}
            />
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm">Pay for week offs they did not get to take</p>
              <p className="text-xs text-muted-foreground">
                Only days they actually worked, and only while week offs are paid.
              </p>
            </div>
            <Switch
              checked={policy.weekOff.payUnused.enabled}
              aria-label="Pay for unused week offs"
              onCheckedChange={(on) =>
                patch("weekOff", {
                  ...policy.weekOff,
                  payUnused: { ...policy.weekOff.payUnused, enabled: on },
                })
              }
            />
          </div>

          {policy.weekOff.payUnused.enabled ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <Field label="Each unused week off is worth" htmlFor="weekOffRate">
                <Select
                  id="weekOffRate"
                  value={policy.weekOff.payUnused.rate.type}
                  onChange={(e) => {
                    const type = e.target
                      .value as PayrollPolicy["weekOff"]["payUnused"]["rate"]["type"];
                    patch("weekOff", {
                      ...policy.weekOff,
                      payUnused: {
                        ...policy.weekOff.payUnused,
                        rate: type === "MULTIPLIER" ? { type, value: 1 } : { type },
                      },
                    });
                  }}
                >
                  <option value="NORMAL_DAY">One day&rsquo;s salary</option>
                  <option value="MULTIPLIER">A multiple of a day&rsquo;s salary</option>
                  <option value="OVERTIME_RATE">A standard day at the overtime rate</option>
                </Select>
              </Field>

              {policy.weekOff.payUnused.rate.type === "MULTIPLIER" ? (
                <Field label="Times a day&rsquo;s salary" htmlFor="weekOffMultiplier">
                  <NumberField
                    id="weekOffMultiplier"
                    min={0}
                    max={10}
                    decimals={2}
                    className="tabular"
                    value={policy.weekOff.payUnused.rate.value}
                    onValueChange={(v) =>
                      patch("weekOff", {
                        ...policy.weekOff,
                        payUnused: {
                          ...policy.weekOff.payUnused,
                          rate: { type: "MULTIPLIER", value: v ?? 1 },
                        },
                      })
                    }
                  />
                </Field>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* ---------- recovery and rounding ---------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">Advances and rounding</h3>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field
              label="Never leave less than (₹)"
              htmlFor="minNet"
              hint="An advance is recovered more slowly rather than taking somebody below this."
            >
              <NumberField
                id="minNet"
                min={0}
                decimals={2}
                className="tabular"
                value={policy.advance.minNetPayPaise / 100}
                onValueChange={(v) =>
                  patch("advance", {
                    ...policy.advance,
                    minNetPayPaise: Math.round((v ?? 0) * 100),
                  })
                }
              />
            </Field>

            <Field label="Round the net pay" htmlFor="roundMode">
              <Select
                id="roundMode"
                value={policy.rounding.mode}
                onChange={(e) =>
                  patch("rounding", {
                    ...policy.rounding,
                    mode: e.target.value as PayrollPolicy["rounding"]["mode"],
                  })
                }
              >
                <option value="NONE">Not at all</option>
                <option value="NEAREST">To the nearest</option>
                <option value="UP">Up</option>
                <option value="DOWN">Down</option>
              </Select>
            </Field>

            {policy.rounding.mode !== "NONE" ? (
              <Field label="Round to (₹)" htmlFor="roundTo">
                {/*
                  The floor is a rupee, which is what the box shows. The old
                  `Math.max(1, …)` floored the *paise*, so clearing the box
                  wedged ₹0.01 in it — an amount nobody rounds a payslip to.
                */}
                <NumberField
                  id="roundTo"
                  min={1}
                  decimals={2}
                  className="tabular"
                  value={policy.rounding.to / 100}
                  onValueChange={(v) =>
                    patch("rounding", {
                      ...policy.rounding,
                      to: Math.round((v ?? 1) * 100),
                    })
                  }
                />
              </Field>
            ) : null}
          </div>
        </section>

        {/* ---------- when ---------- */}
        <section className="space-y-3 border-t border-border pt-4">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field
              label="Takes effect from"
              htmlFor="effectiveFrom"
              required
              hint="Payroll already run for an earlier month keeps the rules it was run under."
            >
              <Input
                id="effectiveFrom"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </Field>
            <Field label="Note" htmlFor="ruleNote" hint="Why, for whoever reads the history.">
              <Input
                id="ruleNote"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Late rule agreed with the works committee"
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button loading={busy} disabled={!dirty || !effectiveFrom} onClick={() => void save()}>
              <Save className="size-4" aria-hidden />
              Save and activate
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !dirty}
              onClick={() => {
                setPolicy(initial);
                setIssues([]);
              }}
            >
              <RotateCcw className="size-4" aria-hidden />
              Undo my changes
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPolicy(initial);
                setIssues([]);
                setOpen(false);
              }}
            >
              Close
            </Button>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
