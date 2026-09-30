"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Calculator, Pencil, Plus, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import { formatMoney } from "@/lib/utils";
import { resolveSalaryStructure, validateSalaryStructure } from "@/domain/payroll/policy";
import type { ComponentCalc, ComponentKind, SalaryComponent } from "@/domain/payroll/types";
import type { ComponentRow, SalaryStructureSnapshot } from "@/services/payroll/salaryStructure";

/**
 * The component editor, and the worked example beside it.
 *
 * The example is the reason this screen can be trusted. It runs the real
 * `resolveSalaryStructure` — the same function payroll runs — over the set as it
 * would stand *including the unsaved edit*, so "BASIC is 50 % of CTC" stops being
 * a sentence somebody has to hold in their head and becomes ₹25,000 next to
 * ₹50,000. `validateSalaryStructure` runs here too, live, which is a convenience
 * and not the check: the service calls it again on the write path, where it is
 * the boundary.
 */

type CalcType = ComponentCalc["type"];

interface Draft {
  id?: string;
  code: string;
  name: string;
  kind: ComponentKind;
  calcType: CalcType;
  percent: string;
  of: string;
  amountRupees: string;
  prorated: boolean;
  taxable: boolean;
  showOnSlip: boolean;
  sortOrder: string;
  active: boolean;
}

const CALC_LABELS: Record<CalcType, string> = {
  PERCENT_OF_CTC: "A percentage of CTC",
  PERCENT_OF_COMPONENT: "A percentage of another component",
  FIXED: "A fixed amount",
  BALANCE: "Whatever is left of the CTC",
};

function emptyDraft(sortOrder: number): Draft {
  return {
    code: "",
    name: "",
    kind: "EARNING",
    calcType: "PERCENT_OF_CTC",
    percent: "0",
    of: "",
    amountRupees: "0",
    prorated: true,
    taxable: true,
    showOnSlip: true,
    sortOrder: String(sortOrder),
    active: true,
  };
}

function toDraft(row: ComponentRow): Draft {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    calcType: row.calc.type,
    percent: String(
      row.calc.type === "PERCENT_OF_CTC" || row.calc.type === "PERCENT_OF_COMPONENT"
        ? row.calc.percent
        : 0,
    ),
    of: row.calc.type === "PERCENT_OF_COMPONENT" ? row.calc.of : "",
    amountRupees: String(row.calc.type === "FIXED" ? row.calc.amountPaise / 100 : 0),
    prorated: row.prorated,
    taxable: row.taxable,
    showOnSlip: row.showOnSlip,
    sortOrder: String(row.sortOrder),
    active: row.active,
  };
}

function number(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function draftCalc(draft: Draft): ComponentCalc {
  switch (draft.calcType) {
    case "PERCENT_OF_CTC":
      return { type: "PERCENT_OF_CTC", percent: number(draft.percent) };
    case "PERCENT_OF_COMPONENT":
      return {
        type: "PERCENT_OF_COMPONENT",
        of: draft.of.trim().toUpperCase(),
        percent: number(draft.percent),
      };
    case "FIXED":
      // Rupees on screen, integer paise on the wire. Never a float for money.
      return { type: "FIXED", amountPaise: Math.round(number(draft.amountRupees) * 100) };
    case "BALANCE":
      return { type: "BALANCE" };
  }
}

function draftComponent(draft: Draft): SalaryComponent {
  return {
    code: draft.code.trim().toUpperCase(),
    name: draft.name.trim() || draft.code.trim().toUpperCase(),
    kind: draft.kind,
    calc: draftCalc(draft),
    prorated: draft.prorated,
    taxable: draft.taxable,
    showOnSlip: draft.showOnSlip,
    sortOrder: Math.round(number(draft.sortOrder)),
  };
}

function toComponent(row: ComponentRow): SalaryComponent {
  return {
    code: row.code,
    name: row.name,
    kind: row.kind,
    calc: row.calc,
    prorated: row.prorated,
    taxable: row.taxable,
    showOnSlip: row.showOnSlip,
    sortOrder: row.sortOrder,
  };
}

function describeCalc(calc: ComponentCalc, percentBase: string): string {
  switch (calc.type) {
    case "PERCENT_OF_CTC":
      return `${calc.percent}% of ${percentBase === "CTC" ? "CTC" : "CTC after fixed amounts"}`;
    case "PERCENT_OF_COMPONENT":
      return `${calc.percent}% of ${calc.of}`;
    case "FIXED":
      return `Fixed ${formatMoney(calc.amountPaise)}`;
    case "BALANCE":
      return "The balance of the CTC";
  }
}

export function SalaryStructure({
  initial,
  canPublish,
}: {
  initial: SalaryStructureSnapshot;
  canPublish: boolean;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [ctcRupees, setCtcRupees] = useState("50000");

  /**
   * The set as it would stand if the draft were saved.
   *
   * The example and the validation both run over this rather than over what is
   * stored, which is the whole point: the answer arrives before the save, not
   * after it.
   */
  const preview = useMemo<SalaryComponent[]>(() => {
    const kept = data.components
      .filter((c) => c.active && c.id !== draft?.id)
      .map(toComponent);
    return draft?.active ? [...kept, draftComponent(draft)] : kept;
  }, [data.components, draft]);

  const issues = useMemo(
    () => validateSalaryStructure(preview, data.percentBase),
    [preview, data.percentBase],
  );

  const ctcPaise = Math.max(0, Math.round(number(ctcRupees) * 100));
  const resolved = useMemo(
    () => resolveSalaryStructure(ctcPaise, preview, data.percentBase),
    [ctcPaise, preview, data.percentBase],
  );

  async function save(body: Record<string, unknown>, success: string) {
    setBusy(true);
    const next = await mutate<SalaryStructureSnapshot>(
      () => api("/api/settings/salary", { method: "POST", body }),
      { success, error: "Nothing was saved" },
    );
    setBusy(false);
    if (next) {
      setData(next);
      router.refresh();
    }
    return next;
  }

  async function submitDraft() {
    if (!draft) return;
    const component = draftComponent(draft);
    const done = await save(
      {
        ...(draft.id ? { id: draft.id } : {}),
        code: component.code,
        name: component.name,
        kind: component.kind,
        calc: component.calc,
        prorated: component.prorated,
        taxable: component.taxable,
        showOnSlip: component.showOnSlip,
        sortOrder: component.sortOrder,
        active: draft.active,
      },
      draft.id ? `${component.code} saved.` : `${component.code} added.`,
    );
    if (done) setDraft(null);
  }

  async function toggleActive(row: ComponentRow, active: boolean) {
    await save(
      {
        id: row.id,
        code: row.code,
        name: row.name,
        kind: row.kind,
        calc: row.calc,
        prorated: row.prorated,
        taxable: row.taxable,
        showOnSlip: row.showOnSlip,
        sortOrder: row.sortOrder,
        active,
      },
      active ? `${row.code} switched on.` : `${row.code} switched off.`,
    );
  }

  const nextSortOrder =
    data.components.reduce((max, c) => Math.max(max, c.sortOrder), 0) + 1;

  return (
    <div className="space-y-4">
      {!canPublish ? (
        <Alert tone="warning" title="You can read this, but not change it">
          Changing the component set changes how everybody is paid, so it also needs permission to
          manage payroll rules. Ask an administrator.
        </Alert>
      ) : null}

      {data.policyIsDefault ? (
        <Alert tone="info" title="Payroll is using the shipped default rules">
          Nothing has been published for this organisation yet, so everything sits in BASIC. Saving
          any component below publishes this set as your rules, from today onwards.
        </Alert>
      ) : null}

      {data.notInPayroll.length > 0 || data.onlyInPayroll.length > 0 ? (
        <Alert tone="warning" title="Payroll is not paying this set">
          {data.notInPayroll.length > 0 ? (
            <p>
              {data.notInPayroll.join(", ")} {data.notInPayroll.length === 1 ? "is" : "are"} listed
              here but not in the payroll rules in force.
            </p>
          ) : null}
          {data.onlyInPayroll.length > 0 ? (
            <p>
              Payroll is currently paying {data.onlyInPayroll.join(", ")}, which{" "}
              {data.onlyInPayroll.length === 1 ? "is" : "are"} not in this list.
            </p>
          ) : null}
          <p className="mt-1">Saving any component below republishes the whole set and clears this.</p>
        </Alert>
      ) : null}

      {issues.length > 0 ? (
        <Alert tone="danger" title="This structure will not save as it stands">
          <ul className="list-inside list-disc">
            {issues.map((issue, i) => (
              <li key={i}>
                {issue.code ? <span className="font-mono text-xs">{issue.code}: </span> : null}
                {issue.message}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
        <Section
          title="Components"
          description="Nothing is deleted here. A code is stamped on every payslip that used it, so an unwanted component is switched off instead."
          action={
            draft === null && canPublish ? (
              <Button size="sm" variant="secondary" onClick={() => setDraft(emptyDraft(nextSortOrder))}>
                <Plus className="size-4" aria-hidden />
                Add component
              </Button>
            ) : null
          }
        >
          {draft ? (
            <ComponentEditor
              draft={draft}
              busy={busy}
              codes={data.components.filter((c) => c.id !== draft.id).map((c) => c.code)}
              onChange={setDraft}
              onCancel={() => setDraft(null)}
              onSubmit={() => void submitDraft()}
              blocked={issues.length > 0}
            />
          ) : null}

          <ResponsiveList
            items={data.components}
            empty={
              <EmptyState
                title="No components yet"
                description="Add at least one earning. Until then payroll pays the whole CTC as BASIC."
              />
            }
            head={
              <>
                <TH>Component</TH>
                <TH>Calculation</TH>
                <TH>Treatment</TH>
                <TH numeric>On</TH>
              </>
            }
            row={(row) => (
              <TR key={row.id}>
                <TD>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{row.code}</span>
                    <span className="font-medium">{row.name}</span>
                    {row.kind === "DEDUCTION" ? <Badge tone="warning">Deduction</Badge> : null}
                    {row.malformed ? (
                      <Badge tone="danger">
                        <TriangleAlert className="size-3" role="img" aria-label="Stored badly" />
                        Unreadable
                      </Badge>
                    ) : null}
                  </div>
                </TD>
                <TD>{describeCalc(row.calc, data.percentBase)}</TD>
                <TD className="text-xs text-muted-foreground">
                  {[
                    row.prorated ? "Prorated" : "Not prorated",
                    row.showOnSlip ? "On the slip" : "Hidden",
                  ].join(" · ")}
                </TD>
                <TD numeric>
                  <div className="flex items-center justify-end gap-2">
                    <Switch
                      checked={row.active}
                      disabled={busy || !canPublish || row.malformed}
                      aria-label={`${row.name} active`}
                      onCheckedChange={(next) => void toggleActive(row, next)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!canPublish}
                      onClick={() => setDraft(toDraft(row))}
                    >
                      <Pencil className="size-4" aria-hidden />
                      <span className="sr-only">Edit {row.name}</span>
                    </Button>
                  </div>
                </TD>
              </TR>
            )}
            card={(row) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    {row.name}
                    {row.kind === "DEDUCTION" ? <Badge tone="warning">Deduction</Badge> : null}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">{row.code}</p>
                  <p className="mt-0.5 text-sm">{describeCalc(row.calc, data.percentBase)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={row.active}
                    disabled={busy || !canPublish || row.malformed}
                    aria-label={`${row.name} active`}
                    onCheckedChange={(next) => void toggleActive(row, next)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canPublish}
                    onClick={() => setDraft(toDraft(row))}
                  >
                    <Pencil className="size-4" aria-hidden />
                    <span className="sr-only">Edit {row.name}</span>
                  </Button>
                </div>
              </div>
            )}
          />
        </Section>

        <WorkedExample
          ctcRupees={ctcRupees}
          onCtcChange={setCtcRupees}
          resolved={resolved}
          ctcPaise={ctcPaise}
          unsaved={draft !== null}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Editor                                                                     */
/* -------------------------------------------------------------------------- */

function ComponentEditor({
  draft,
  busy,
  codes,
  blocked,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: Draft;
  busy: boolean;
  codes: string[];
  blocked: boolean;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const editing = Boolean(draft.id);

  return (
    <div className="space-y-4 border-b border-border bg-muted/30 p-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <Field
          label="Code"
          htmlFor="sc-code"
          required
          hint={
            editing
              ? "Stamped on every payslip that used it, so it cannot be changed."
              : "UPPER_SNAKE_CASE. This is what payslips and settlements refer to."
          }
        >
          <Input
            id="sc-code"
            value={draft.code}
            disabled={editing}
            placeholder="HRA"
            onChange={(e) => set({ code: e.target.value.toUpperCase() })}
          />
        </Field>

        <Field label="Name" htmlFor="sc-name" required hint="What a person reads on their payslip.">
          <Input
            id="sc-name"
            value={draft.name}
            placeholder="House Rent Allowance"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>

        <Field label="Kind" htmlFor="sc-kind" required>
          <Select
            id="sc-kind"
            value={draft.kind}
            onChange={(e) => set({ kind: e.target.value as ComponentKind })}
          >
            <option value="EARNING">Earning</option>
            <option value="DEDUCTION">Deduction</option>
          </Select>
        </Field>

        <Field label="Calculated as" htmlFor="sc-calc" required>
          <Select
            id="sc-calc"
            value={draft.calcType}
            onChange={(e) => set({ calcType: e.target.value as CalcType })}
          >
            {(Object.keys(CALC_LABELS) as CalcType[]).map((type) => (
              <option key={type} value={type}>
                {CALC_LABELS[type]}
              </option>
            ))}
          </Select>
        </Field>

        {draft.calcType === "PERCENT_OF_CTC" || draft.calcType === "PERCENT_OF_COMPONENT" ? (
          <Field label="Percentage" htmlFor="sc-percent" required>
            <Input
              id="sc-percent"
              type="number"
              min={0}
              step="0.01"
              value={draft.percent}
              onChange={(e) => set({ percent: e.target.value })}
            />
          </Field>
        ) : null}

        {draft.calcType === "PERCENT_OF_COMPONENT" ? (
          <Field
            label="Of which component"
            htmlFor="sc-of"
            required
            hint="Employer PF is typically a percentage of BASIC."
          >
            <Select id="sc-of" value={draft.of} onChange={(e) => set({ of: e.target.value })}>
              <option value="">Choose a component</option>
              {codes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        {draft.calcType === "FIXED" ? (
          <Field label="Amount (₹ per month)" htmlFor="sc-amount" required>
            <Input
              id="sc-amount"
              type="number"
              min={0}
              step="0.01"
              value={draft.amountRupees}
              onChange={(e) => set({ amountRupees: e.target.value })}
            />
          </Field>
        ) : null}

        <Field
          label="Order on the payslip"
          htmlFor="sc-order"
          hint="Lower numbers come first."
        >
          <Input
            id="sc-order"
            type="number"
            min={0}
            value={draft.sortOrder}
            onChange={(e) => set({ sortOrder: e.target.value })}
          />
        </Field>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-3">
        <Toggle
          id="sc-prorated"
          label="Prorated"
          hint="Reduced when somebody is paid for part of a month. Reimbursements usually are not."
          checked={draft.prorated}
          onChange={(prorated) => set({ prorated })}
        />
        {/* No "Taxable" switch.
            `SalaryComponent.taxable` is in the schema and no calculation reads
            it: income tax here is a flat monthly figure an administrator types
            in, so marking a component taxable changed precisely nothing while
            looking like it changed a deduction. The field is kept, because it is
            the right shape for TDS when there is TDS -- but a control that does
            nothing is worse than no control, so it is not offered until it
            does. */}
        <Toggle
          id="sc-slip"
          label="Show on the payslip"
          checked={draft.showOnSlip}
          onChange={(showOnSlip) => set({ showOnSlip })}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Toggle
          id="sc-active"
          label="In use"
          hint="Switched off, it leaves the structure from today onwards and stays on old payslips."
          checked={draft.active}
          onChange={(active) => set({ active })}
        />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            <X className="size-4" aria-hidden />
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={busy || blocked || draft.code.trim().length === 0 || draft.name.trim().length < 2}
            onClick={onSubmit}
          >
            {editing ? "Save component" : "Add component"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <label htmlFor={id} className="text-sm">
        {label}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </label>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Worked example                                                             */
/* -------------------------------------------------------------------------- */

function WorkedExample({
  ctcRupees,
  onCtcChange,
  resolved,
  ctcPaise,
  unsaved,
}: {
  ctcRupees: string;
  onCtcChange: (value: string) => void;
  resolved: ReturnType<typeof resolveSalaryStructure>;
  ctcPaise: number;
  unsaved: boolean;
}) {
  const matches = resolved.grossPaise === ctcPaise;

  return (
    <Section
      title="Worked example"
      description={
        unsaved
          ? "Including the change you have not saved yet."
          : "What the structure above pays, component by component."
      }
    >
      <div className="space-y-3 p-4">
        <Field
          label="Monthly CTC (₹)"
          htmlFor="sc-example-ctc"
          hint="A real salary from your organisation is the best test."
        >
          <Input
            id="sc-example-ctc"
            type="number"
            min={0}
            step="1"
            value={ctcRupees}
            onChange={(e) => onCtcChange(e.target.value)}
          />
        </Field>

        {resolved.earnings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Add an earning component and the breakdown appears here.
          </p>
        ) : (
          <dl className="divide-y divide-border text-sm">
            {resolved.earnings.map((line) => (
              <div key={line.component.code} className="flex items-baseline justify-between gap-3 py-2">
                <div className="min-w-0">
                  <dt className="truncate font-medium">{line.component.name}</dt>
                  <dd className="truncate text-xs text-muted-foreground">{line.formula}</dd>
                </div>
                <dd className="tabular shrink-0 font-medium">{formatMoney(line.amountPaise)}</dd>
              </div>
            ))}

            <div className="flex items-baseline justify-between gap-3 py-2 font-semibold">
              <dt>Gross</dt>
              <dd className="tabular">{formatMoney(resolved.grossPaise)}</dd>
            </div>

            {resolved.deductions.length > 0 ? (
              <div className="pt-2">
                <p className="mb-1 text-xs font-medium text-muted-foreground">Deductions</p>
                {resolved.deductions.map((line) => (
                  <div
                    key={line.component.code}
                    className="flex items-baseline justify-between gap-3 py-1"
                  >
                    <dt className="truncate">{line.component.name}</dt>
                    <dd className="tabular shrink-0">−{formatMoney(line.amountPaise)}</dd>
                  </div>
                ))}
              </div>
            ) : null}
          </dl>
        )}

        {resolved.earnings.length > 0 ? (
          <p
            className={
              matches
                ? "flex items-start gap-1.5 text-xs text-success-text"
                : "flex items-start gap-1.5 text-xs text-danger-text"
            }
          >
            <Calculator className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {matches
                ? `The components add up to the ${formatMoney(ctcPaise)} CTC exactly.`
                : `The components add up to ${formatMoney(resolved.grossPaise)}, not the ${formatMoney(ctcPaise)} CTC.`}
              {resolved.roundingResidualPaise !== 0
                ? ` ${Math.abs(resolved.roundingResidualPaise)} paise of rounding was absorbed to make it so.`
                : ""}
            </span>
          </p>
        ) : null}

        <p className="border-t border-border pt-3 text-xs text-muted-foreground">
          This is the monthly structure only. Attendance, unpaid leave, overtime, advances and
          statutory deductions are applied on top of it when a month is actually run.
        </p>
      </div>
    </Section>
  );
}
