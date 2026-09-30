"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, RotateCcw, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { SOURCE_HINTS, SOURCE_LABELS, SOURCE_UNIT, UNIT_LABELS } from "@/domain/recognition/units";

/**
 * What the award is decided on, and how much each thing counts.
 *
 * Everything is edited together and saved in one go, because "the weights must
 * total 100" is a rule about the set: saved a row at a time there is no moment
 * at which it has to hold, and the scheme spends most of its life invalid. The
 * running total is on screen the whole time for the same reason.
 *
 * The AI panels below suggest and explain. Neither of them saves anything —
 * they fill the form, and saving stays a deliberate act by a person.
 */

type Unit = "RUPEES" | "COUNT" | "PERCENT" | "HOURS" | "POINTS";
type Direction = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
type Source = "MANUAL" | "PRESENT_DAYS" | "PUNCTUALITY" | "OVERTIME_HOURS" | "GOALS_COMPLETED";

interface Parameter {
  id: string;
  name: string;
  unit: Unit;
  direction: Direction;
  weight: number;
  source: Source;
  active: boolean;
  used: boolean;
}

interface Setup {
  parameters: Parameter[];
  settings: { cooldownMonths: number };
  weightsTotal: number;
  weightsValid: boolean;
  maxParameters: number;
}

interface Row {
  key: string;
  id?: string;
  name: string;
  unit: Unit;
  direction: Direction;
  weight: number;
  source: Source;
}

const UNITS = Object.keys(UNIT_LABELS) as Unit[];
const SOURCES = Object.keys(SOURCE_LABELS) as Source[];

let nextKey = 0;
const rowsFrom = (parameters: Parameter[]): Row[] =>
  parameters
    .filter((p) => p.active)
    .map((p) => ({
      key: `p${nextKey++}`,
      id: p.id,
      name: p.name,
      unit: p.unit,
      direction: p.direction,
      weight: p.weight,
      source: p.source,
    }));

export function ParameterEditor({ initial, aiAvailable }: { initial: Setup; aiAvailable: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState(initial);
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(initial.parameters));
  const [cooldown, setCooldown] = useState(String(initial.settings.cooldownMonths));
  const [busy, setBusy] = useState(false);

  const retired = setup.parameters.filter((p) => !p.active);
  const total = rows.reduce((sum, r) => sum + (Number.isFinite(r.weight) ? r.weight : 0), 0);
  const balanced = total === 100 || rows.length === 0;

  function patch(key: string, change: Partial<Row>) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row;
        const next = { ...row, ...change };
        // A derived measure's unit is not a choice: days present are a count.
        const forced = SOURCE_UNIT[next.source];
        return forced ? { ...next, unit: forced as Unit } : next;
      }),
    );
  }

  /** Spreads 100 across the rows, so nobody has to do the arithmetic by hand. */
  function levelWeights() {
    if (rows.length === 0) return;
    const each = Math.floor(100 / rows.length);
    setRows((current) =>
      current.map((row, index) => ({
        ...row,
        // The remainder lands on the first row rather than being lost.
        weight: index === 0 ? 100 - each * (current.length - 1) : each,
      })),
    );
  }

  async function save() {
    setBusy(true);
    const result = await mutate<Setup>(
      () =>
        api("/api/recognition/parameters", {
          method: "PUT",
          body: {
            parameters: rows.map((row) => ({
              id: row.id,
              name: row.name.trim(),
              unit: row.unit,
              direction: row.direction,
              weight: row.weight,
              source: row.source,
              active: true,
            })),
            cooldownMonths: Number(cooldown),
          },
        }),
      { success: "Saved.", error: "Nothing was saved" },
    );
    setBusy(false);

    if (result) {
      setSetup(result);
      setRows(rowsFrom(result.parameters));
      router.refresh();
    }
  }

  async function remove(parameter: Parameter) {
    setBusy(true);
    const done = await mutate<{ deleted: boolean }>(
      () => api(`/api/recognition/parameters/${parameter.id}`, { method: "DELETE" }),
      { error: "It was not removed" },
    );
    setBusy(false);

    if (done) {
      setSetup((current) => ({
        ...current,
        parameters: done.deleted
          ? current.parameters.filter((p) => p.id !== parameter.id)
          : current.parameters,
      }));
      router.refresh();
    }
  }

  return (
    <Section
      title="What the month is decided on"
      description={`Up to ${setup.maxParameters} measures; three is usually enough for anybody to follow.`}
      action={
        <span className="flex items-center gap-2">
          <Badge tone={balanced ? "success" : "warning"}>{total} / 100</Badge>
          <Button size="sm" loading={busy} disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        </span>
      }
    >
      <div className="space-y-4 p-4">
        {!balanced ? (
          <Alert tone="warning" title="The weights do not add up to 100">
            A score out of 100 means the weights total 100. Adjust them, or use{" "}
            <button type="button" className="underline underline-offset-2" onClick={levelWeights}>
              spread evenly
            </button>
            .
          </Alert>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing is being measured yet"
            description="Add what a good month looks like in your organisation — sales, punctuality, escalations avoided."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.key} className="rounded-lg border border-border p-3">
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Name" htmlFor={`name-${row.key}`}>
                    <Input
                      id={`name-${row.key}`}
                      value={row.name}
                      placeholder="Sales"
                      maxLength={60}
                      onChange={(e) => patch(row.key, { name: e.target.value })}
                    />
                  </Field>

                  <Field
                    label="Where the figure comes from"
                    htmlFor={`source-${row.key}`}
                    hint={SOURCE_HINTS[row.source]}
                  >
                    <Select
                      id={`source-${row.key}`}
                      value={row.source}
                      onChange={(e) => patch(row.key, { source: e.target.value as Source })}
                    >
                      {SOURCES.map((source) => (
                        <option key={source} value={source}>
                          {SOURCE_LABELS[source]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <Field label="Unit" htmlFor={`unit-${row.key}`}>
                    <Select
                      id={`unit-${row.key}`}
                      value={row.unit}
                      // Fixed by the source for anything counted from real data.
                      disabled={SOURCE_UNIT[row.source] !== null}
                      onChange={(e) => patch(row.key, { unit: e.target.value as Unit })}
                    >
                      {UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {UNIT_LABELS[unit]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Which way" htmlFor={`direction-${row.key}`}>
                      <Select
                        id={`direction-${row.key}`}
                        value={row.direction}
                        onChange={(e) => patch(row.key, { direction: e.target.value as Direction })}
                      >
                        <option value="HIGHER_IS_BETTER">More is better</option>
                        <option value="LOWER_IS_BETTER">Less is better</option>
                      </Select>
                    </Field>

                    <Field label="Weight" htmlFor={`weight-${row.key}`}>
                      <NumberField
                        id={`weight-${row.key}`}
                        min={0}
                        max={100}
                        value={row.weight}
                        onValueChange={(v) => patch(row.key, { weight: v ?? 0 })}
                      />
                    </Field>
                  </div>
                </div>

                <div className="mt-2 flex justify-end">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                  >
                    <X className="size-4" aria-hidden />
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={rows.length >= setup.maxParameters}
            onClick={() =>
              setRows((current) => [
                ...current,
                {
                  key: `p${nextKey++}`,
                  name: "",
                  unit: "COUNT",
                  direction: "HIGHER_IS_BETTER",
                  weight: 0,
                  source: "MANUAL",
                },
              ])
            }
          >
            <Plus className="size-4" aria-hidden />
            Add a measure
          </Button>
          {rows.length > 1 ? (
            <Button size="sm" variant="ghost" onClick={levelWeights}>
              Spread the weights evenly
            </Button>
          ) : null}
          {rows.length >= setup.maxParameters ? (
            <span className="text-xs text-muted-foreground">
              {setup.maxParameters} is the limit. Past that, nobody can be told why they did not win.
            </span>
          ) : null}
        </div>

        <div className="border-t border-border pt-4">
          <Field
            label="Cooldown"
            htmlFor="cooldown"
            hint="Somebody who has won recently is not eligible again for this long. Off by default."
          >
            <Select
              id="cooldown"
              className="max-w-xs"
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
            >
              <option value="0">No cooldown — anybody can win every month</option>
              <option value="2">Not again within 2 months</option>
              <option value="3">Not again within 3 months</option>
              <option value="6">Not again within 6 months</option>
              <option value="12">Not again within 12 months</option>
            </Select>
          </Field>
        </div>

        {retired.length > 0 ? (
          <div className="border-t border-border pt-4">
            <h3 className="text-sm font-semibold">No longer in use</h3>
            <p className="text-xs text-muted-foreground">
              Kept because published months were scored on them.
            </p>
            <ul className="mt-2 divide-y divide-border">
              {retired.map((parameter) => (
                <li key={parameter.id} className="flex items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{parameter.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || rows.length >= setup.maxParameters}
                    onClick={() =>
                      setRows((current) => [
                        ...current,
                        {
                          key: `p${nextKey++}`,
                          id: parameter.id,
                          name: parameter.name,
                          unit: parameter.unit,
                          direction: parameter.direction,
                          weight: 0,
                          source: parameter.source,
                        },
                      ])
                    }
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    Use again
                  </Button>
                  {parameter.used ? (
                    <Badge tone="neutral">scored</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void remove(parameter)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      Delete
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {aiAvailable ? (
          <div className="space-y-3 border-t border-border pt-4">
            <SuggestParameters onUse={(suggested) => setRows(suggested)} />
            {rows.length > 0 ? (
              <SuggestWeights
                parameters={rows.filter((r) => r.id).map((r) => ({ id: r.id!, name: r.name }))}
                onApply={(weights) =>
                  setRows((current) =>
                    current.map((row) => (row.id && weights[row.id] != null ? { ...row, weight: weights[row.id]! } : row)),
                  )
                }
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------- suggesting measures */

interface Suggestion {
  parameters: { name: string; unit: Unit; direction: Direction; source: Source; weight: number; encourages: string }[];
  note: string;
  problems: string[];
  applicable: boolean;
}

function SuggestParameters({ onUse }: { onUse: (rows: Row[]) => void }) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Suggestion | null>(null);

  async function suggest() {
    setBusy(true);
    const suggestion = await mutate<Suggestion>(
      () =>
        api("/api/recognition/ai", {
          method: "POST",
          body: { kind: "parameters", description: description.trim() },
        }),
      { error: "Nothing was suggested" },
    );
    setBusy(false);
    if (suggestion) setResult(suggestion);
  }

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Sparkles className="size-4" aria-hidden />
        Suggest measures for my organisation
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <Field
        label="What does your organisation do, and what does a good month look like?"
        htmlFor="ai-description"
        hint="For example: a retail chain of forty people; a good month is high sales, low stock shrinkage and no missed shifts."
      >
        <Textarea
          id="ai-description"
          rows={3}
          maxLength={2000}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" loading={busy} disabled={busy || description.trim().length < 15} onClick={() => void suggest()}>
          Suggest
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      {result ? (
        <div className="mt-3 space-y-2">
          {result.problems.map((problem) => (
            <Alert key={problem} tone="warning">
              {problem}
            </Alert>
          ))}

          <ul className="divide-y divide-border rounded-md border border-border">
            {result.parameters.map((parameter) => (
              <li key={parameter.name} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{parameter.name}</span>
                  <Badge tone="primary">{parameter.weight}%</Badge>
                  <Badge tone="neutral">
                    {parameter.direction === "LOWER_IS_BETTER" ? "less is better" : "more is better"}
                  </Badge>
                  <Badge tone="outline">{SOURCE_LABELS[parameter.source]}</Badge>
                </div>
                {/* The sentence that matters: what measuring this will make people do. */}
                <p className="mt-1 text-xs text-muted-foreground">{parameter.encourages}</p>
              </li>
            ))}
          </ul>

          {result.note ? <p className="text-xs text-muted-foreground">{result.note}</p> : null}

          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onUse(
                result.parameters.map((p) => ({
                  key: `p${nextKey++}`,
                  name: p.name,
                  unit: p.unit,
                  direction: p.direction,
                  weight: p.weight,
                  source: p.source,
                })),
              );
              setOpen(false);
            }}
          >
            Put these in the form
          </Button>
          <p className="text-xs text-muted-foreground">
            Nothing is saved until you press Save — edit anything you disagree with first.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------- suggesting weights */

interface WeightSuggestion {
  weights: { parameterId: string; name: string; from: number; to: number }[];
  rewards: string[];
  cost: string;
  problems: string[];
  evidence: {
    period: { label: string };
    current: { rank: number; employeeId: string; name: string; totalScore: number }[];
    proposed: { rank: number; employeeId: string; name: string; totalScore: number }[];
    changesTheWinner: boolean;
  } | null;
}

function SuggestWeights({
  parameters,
  onApply,
}: {
  parameters: { id: string; name: string }[];
  onApply: (weights: Record<string, number>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [emphasis, setEmphasis] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WeightSuggestion | null>(null);

  async function suggest() {
    setBusy(true);
    const suggestion = await mutate<WeightSuggestion>(
      () =>
        api("/api/recognition/ai", {
          method: "POST",
          body: { kind: "weights", emphasis: emphasis.trim() },
        }),
      { error: "Nothing was suggested" },
    );
    setBusy(false);
    if (suggestion) setResult(suggestion);
  }

  if (parameters.length === 0) return null;

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <Sparkles className="size-4" aria-hidden />
        Suggest weights, and what they would reward
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <Field
        label="What should this award reward?"
        htmlFor="ai-emphasis"
        hint="For example: consistency over heroics, or the people who keep the shop floor covered."
      >
        <Input
          id="ai-emphasis"
          value={emphasis}
          maxLength={1000}
          onChange={(e) => setEmphasis(e.target.value)}
        />
      </Field>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" loading={busy} disabled={busy || emphasis.trim().length < 5} onClick={() => void suggest()}>
          Suggest
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>

      {result ? (
        <div className="mt-3 space-y-3">
          {result.problems.map((problem) => (
            <Alert key={problem} tone="warning">
              {problem}
            </Alert>
          ))}

          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            {result.weights.map((weight) => (
              <li key={weight.parameterId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate">{weight.name}</span>
                <span className="tabular shrink-0 text-muted-foreground">
                  {weight.from} → <span className="font-medium text-foreground">{weight.to}</span>
                </span>
              </li>
            ))}
          </ul>

          <div>
            <p className="text-xs font-medium">What this rewards</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {result.rewards.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          <Alert tone="warning" title="And what it does not">
            {result.cost}
          </Alert>

          {/* Not the model's opinion: the real engine, run over a real month. */}
          {result.evidence ? (
            <div className="rounded-md border border-border p-3">
              <p className="text-xs font-medium">
                {result.evidence.period.label}, scored both ways
              </p>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                <Ranking title="As it is now" places={result.evidence.current} />
                <Ranking title="With these weights" places={result.evidence.proposed} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {result.evidence.changesTheWinner
                  ? "These weights would have picked a different winner that month."
                  : "The same person would have won that month either way."}
              </p>
            </div>
          ) : null}

          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onApply(Object.fromEntries(result.weights.map((w) => [w.parameterId, w.to])));
              setOpen(false);
            }}
          >
            Put these weights in the form
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Ranking({
  title,
  places,
}: {
  title: string;
  places: { rank: number; employeeId: string; name: string; totalScore: number }[];
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{title}</p>
      <ol className="mt-1 space-y-0.5 text-xs">
        {places.slice(0, 3).map((place) => (
          <li key={place.employeeId} className="flex justify-between gap-2">
            <span className="min-w-0 truncate">
              {place.rank}. {place.name}
            </span>
            <span className="tabular shrink-0 text-muted-foreground">{place.totalScore.toFixed(2)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
