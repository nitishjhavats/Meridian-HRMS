"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/ui/stat";
import { Alert, LoadFailed, Spinner } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";

/**
 * PF, ESI, professional tax and TDS, without a language model.
 *
 * These four live inside the payroll policy, and the only screen that had ever
 * written that policy was the AI prompt box beside this one — so an
 * organisation with no OpenRouter key could not turn provident fund on at all.
 *
 * All four are off until somebody switches them on. Nothing is deducted from
 * anybody's pay because this screen appeared.
 */

interface Statutory {
  providentFund: {
    enabled: boolean;
    employeePercent: number;
    wageCeilingPaise: number;
    componentCode: string;
  };
  esi: { enabled: boolean; employeePercent: number; wageCeilingPaise: number };
  professionalTax: { enabled: boolean; slabs: { uptoPaise: number; amountPaise: number }[] };
  incomeTax: { enabled: boolean; monthlyFlatPaise: number };
}

interface Loaded {
  statutory: Statutory;
  isDefault: boolean;
  earningComponents: { code: string; name: string }[];
}

/**
 * Money is stored in paise and typed in rupees. Nothing else in the UI differs.
 *
 * A blank box is zero here, and means it in every case: a ceiling of nothing is
 * no ceiling, and a deduction of nothing is no deduction.
 */
const toRupees = (paise: number) => paise / 100;
const toPaise = (rupees: number | null) => Math.round((rupees ?? 0) * 100);

export function Statutory({ canWrite }: { canWrite: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<Loaded | null>(null);
  const [form, setForm] = useState<Statutory | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  /**
   * A failed load is said, with a retry. This used to `.catch(() => null)`
   * and leave "Loading…" up for good on a flaky connection or after a 5xx, so
   * the owner reported the deductions as "missing" with nothing to quote.
   */
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const result = await api<Loaded>("/api/payroll/statutory");
      setData(result);
      setForm(result.statutory);
    } catch (error) {
      setLoadError(error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!form || !data) {
    return (
      <Section title="Statutory deductions">
        {loadError !== null ? (
          <div className="p-4">
            <LoadFailed
              compact
              error={loadError}
              what="Statutory deductions"
              onRetry={() => void load()}
            />
          </div>
        ) : (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </p>
        )}
      </Section>
    );
  }

  const set = <K extends keyof Statutory>(key: K, value: Statutory[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const dirty = JSON.stringify(form) !== JSON.stringify(data.statutory);

  async function save() {
    if (!form) return;
    setBusy(true);
    const result = await mutate<{ statutory: Statutory }>(
      () => api("/api/payroll/statutory", { method: "PUT", body: form }),
      { success: "Statutory deductions saved.", error: "Nothing was saved" },
    );
    setBusy(false);
    if (result) {
      setData((d) => (d ? { ...d, statutory: result.statutory, isDefault: false } : d));
      setForm(result.statutory);
      router.refresh();
    }
  }

  return (
    <Section
      title="Statutory deductions"
      description="Provident fund, ESI, professional tax and income tax. All off until you switch them on."
    >
      <div className="space-y-5 p-4">
        <Alert tone="info" title="These come out of somebody's pay">
          A change here applies from today and is published as a new policy version, so payroll
          runs already locked keep the figures they were locked with.
        </Alert>

        {/* ---------------------------------------------------------- PF --- */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Provident fund</p>
              <p className="text-xs text-muted-foreground">
                A percentage of one earning, capped at a wage ceiling.
              </p>
            </div>
            <Switch
              checked={form.providentFund.enabled}
              disabled={!canWrite || busy}
              aria-label="Provident fund"
              onCheckedChange={(on) =>
                set("providentFund", { ...form.providentFund, enabled: on })
              }
            />
          </div>

          {form.providentFund.enabled ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3">
              <Field label="Employee share (%)" htmlFor="pfPercent">
                <NumberField
                  id="pfPercent"
                  min={0}
                  max={100}
                  decimals={2}
                  className="tabular"
                  disabled={!canWrite}
                  value={form.providentFund.employeePercent}
                  onValueChange={(v) =>
                    set("providentFund", {
                      ...form.providentFund,
                      employeePercent: v ?? 0,
                    })
                  }
                />
              </Field>
              <Field label="Wage ceiling (₹)" htmlFor="pfCeiling" hint="0 means no ceiling.">
                <NumberField
                  id="pfCeiling"
                  min={0}
                  decimals={2}
                  className="tabular"
                  disabled={!canWrite}
                  value={toRupees(form.providentFund.wageCeilingPaise)}
                  onValueChange={(v) =>
                    set("providentFund", {
                      ...form.providentFund,
                      wageCeilingPaise: toPaise(v),
                    })
                  }
                />
              </Field>
              <Field
                label="Calculated on"
                htmlFor="pfComponent"
                hint="Usually Basic. Pointing it at something that does not exist would deduct from the whole gross."
              >
                <Select
                  id="pfComponent"
                  disabled={!canWrite}
                  value={form.providentFund.componentCode}
                  onChange={(e) =>
                    set("providentFund", {
                      ...form.providentFund,
                      componentCode: e.target.value,
                    })
                  }
                >
                  {data.earningComponents.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ) : null}
        </div>

        {/* --------------------------------------------------------- ESI --- */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">ESI</p>
              <p className="text-xs text-muted-foreground">
                A percentage of gross, and only for people under the ceiling.
              </p>
            </div>
            <Switch
              checked={form.esi.enabled}
              disabled={!canWrite || busy}
              aria-label="ESI"
              onCheckedChange={(on) => set("esi", { ...form.esi, enabled: on })}
            />
          </div>

          {form.esi.enabled ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <Field label="Employee share (%)" htmlFor="esiPercent">
                <NumberField
                  id="esiPercent"
                  min={0}
                  max={100}
                  decimals={2}
                  className="tabular"
                  disabled={!canWrite}
                  value={form.esi.employeePercent}
                  onValueChange={(v) => set("esi", { ...form.esi, employeePercent: v ?? 0 })}
                />
              </Field>
              <Field
                label="Wage ceiling (₹)"
                htmlFor="esiCeiling"
                hint="Above this, nothing is deducted. 0 means everybody."
              >
                <NumberField
                  id="esiCeiling"
                  min={0}
                  decimals={2}
                  className="tabular"
                  disabled={!canWrite}
                  value={toRupees(form.esi.wageCeilingPaise)}
                  onValueChange={(v) => set("esi", { ...form.esi, wageCeilingPaise: toPaise(v) })}
                />
              </Field>
            </div>
          ) : null}
        </div>

        {/* ---------------------------------------------- professional tax --- */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Professional tax</p>
              <p className="text-xs text-muted-foreground">
                A flat amount per slab, decided by the state. The first slab whose ceiling the
                gross falls under is the one that applies.
              </p>
            </div>
            <Switch
              checked={form.professionalTax.enabled}
              disabled={!canWrite || busy}
              aria-label="Professional tax"
              onCheckedChange={(on) =>
                set("professionalTax", { ...form.professionalTax, enabled: on })
              }
            />
          </div>

          {form.professionalTax.enabled ? (
            <div className="space-y-2">
              {form.professionalTax.slabs.map((slab, index) => (
                <div key={index} className="flex flex-wrap items-end gap-2">
                  <Field label="Gross up to (₹)" htmlFor={`ptUpto${index}`}>
                    <NumberField
                      id={`ptUpto${index}`}
                      min={0}
                      decimals={2}
                      className="tabular w-36"
                      disabled={!canWrite}
                      value={toRupees(slab.uptoPaise)}
                      onValueChange={(v) => {
                        const slabs = [...form.professionalTax.slabs];
                        slabs[index] = { ...slab, uptoPaise: toPaise(v) };
                        set("professionalTax", { ...form.professionalTax, slabs });
                      }}
                    />
                  </Field>
                  <Field label="Deduct (₹)" htmlFor={`ptAmount${index}`}>
                    <NumberField
                      id={`ptAmount${index}`}
                      min={0}
                      decimals={2}
                      className="tabular w-32"
                      disabled={!canWrite}
                      value={toRupees(slab.amountPaise)}
                      onValueChange={(v) => {
                        const slabs = [...form.professionalTax.slabs];
                        slabs[index] = { ...slab, amountPaise: toPaise(v) };
                        set("professionalTax", { ...form.professionalTax, slabs });
                      }}
                    />
                  </Field>
                  {canWrite ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove slab ${index + 1}`}
                      onClick={() =>
                        set("professionalTax", {
                          ...form.professionalTax,
                          slabs: form.professionalTax.slabs.filter((_, i) => i !== index),
                        })
                      }
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              ))}

              {canWrite ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    set("professionalTax", {
                      ...form.professionalTax,
                      slabs: [...form.professionalTax.slabs, { uptoPaise: 0, amountPaise: 0 }],
                    })
                  }
                >
                  <Plus className="size-4" aria-hidden />
                  Add a slab
                </Button>
              ) : null}

              {form.professionalTax.slabs.length === 0 ? (
                <p className="text-xs text-warning-text">
                  With no slabs, professional tax deducts nothing.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* --------------------------------------------------------- TDS --- */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Income tax (TDS)</p>
              <p className="text-xs text-muted-foreground">
                A flat monthly figure. This product does not compute slabs, regimes, exemptions
                or a year-to-date projection — your accountant gives you the number.
              </p>
            </div>
            <Switch
              checked={form.incomeTax.enabled}
              disabled={!canWrite || busy}
              aria-label="Income tax"
              onCheckedChange={(on) => set("incomeTax", { ...form.incomeTax, enabled: on })}
            />
          </div>

          {form.incomeTax.enabled ? (
            <Field label="Per month (₹)" htmlFor="tdsAmount">
              <NumberField
                id="tdsAmount"
                min={0}
                decimals={2}
                className="tabular w-40"
                disabled={!canWrite}
                value={toRupees(form.incomeTax.monthlyFlatPaise)}
                onValueChange={(v) =>
                  set("incomeTax", {
                    ...form.incomeTax,
                    monthlyFlatPaise: toPaise(v),
                  })
                }
              />
            </Field>
          ) : null}
        </div>

        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} disabled={busy || !dirty} onClick={() => void save()}>
              Save deductions
            </Button>
            {dirty ? (
              <Button variant="ghost" disabled={busy} onClick={() => setForm(data.statutory)}>
                Discard
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}
