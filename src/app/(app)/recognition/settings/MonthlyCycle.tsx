"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Send,
  Sparkles,
  Trophy,
  UserMinus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { Table, TBody, TD, TH, THead, TR, TableWrap } from "@/components/ui/table";
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
import { formatRecognitionValue, type RecognitionUnitKey } from "@/domain/recognition/units";
import { initials, pluralise } from "@/lib/utils";

/**
 * One month: the figures, the draft ranking with all its workings, and publish.
 *
 * The whole screen is built around being able to answer "why did they win" with
 * a table rather than an assurance. Every raw figure, every normalised figure
 * and every weighted contribution is on screen before anything is published,
 * and the people whose figures are missing are named at the top rather than
 * quietly scoring zero.
 */

type Unit = RecognitionUnitKey;

interface Period {
  year: number;
  month: number;
  label: string;
}

interface Parameter {
  id: string;
  name: string;
  unit: Unit;
  direction: "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
  weight: number;
  source: string;
}

interface EntryRow {
  employeeId: string;
  name: string;
  employeeCode: string;
  designation: string | null;
  values: Record<string, number | null>;
}

interface MonthlyEntry {
  period: Period;
  status: string;
  editable: boolean;
  parameters: Parameter[];
  rows: EntryRow[];
}

interface Working {
  parameterId: string;
  parameterName: string;
  unit: Unit;
  direction: "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";
  weight: number;
  raw: number | null;
  missing: boolean;
  normalised: number;
  contribution: number;
  uniform: boolean;
}

interface RankedRow {
  rank: number;
  employeeId: string;
  name: string;
  employeeCode: string;
  photoUrl: string | null;
  designation: string | null;
  department: string | null;
  totalScore: number;
  presentDays: number;
  workings: Working[];
  tie: { tiedWith: string[]; reason: string | null; parameterName: string | null } | null;
  awardsWon: number;
}

interface Preview {
  period: Period;
  status: string;
  publishedAt: string | null;
  citation: string | null;
  parameters: (Parameter & { min: number | null; max: number | null; entered: number; uniform: boolean })[];
  settings: { cooldownMonths: number };
  weightsTotal: number;
  weightsValid: boolean;
  ranked: RankedRow[];
  excluded: { employeeId: string; name: string; employeeCode: string; reason: string; detail: string }[];
  incomplete: { employeeId: string; name: string; parameters: string[] }[];
  canPublish: boolean;
  blockers: string[];
  override: { employeeId: string; name: string; reason: string } | null;
}

const TIE_EXPLANATION: Record<string, string> = {
  PARAMETER: "placed by the heaviest measure",
  ATTENDANCE: "placed on days present",
  JOINING_DATE: "placed on length of service",
  STABLE_ORDER: "nothing separated them",
};

function shift(period: Period, months: number): { year: number; month: number } {
  const index = period.year * 12 + (period.month - 1) + months;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function MonthlyCycle({
  initialPeriod,
  initialEntry,
  initialPreview,
  currency,
  aiAvailable,
}: {
  initialPeriod: Period;
  initialEntry: MonthlyEntry;
  initialPreview: Preview;
  currency: string;
  aiAvailable: boolean;
}) {
  const router = useRouter();
  const [period, setPeriod] = useState(initialPeriod);
  const [entry, setEntry] = useState(initialEntry);
  const [preview, setPreview] = useState(initialPreview);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // One month either side of two years, so the month in progress can be looked
  // at (and is refused publication) without hunting for it.
  const months = Array.from({ length: 25 }, (_, i) => shift(initialPeriod, 1 - i));
  const published = preview.status === "PUBLISHED";
  const expandedRow = preview.ranked.find((r) => r.employeeId === expanded) ?? null;

  async function load(next: { year: number; month: number }) {
    setBusy(true);
    const [nextEntry, nextPreview] = await Promise.all([
      api<MonthlyEntry>(`/api/recognition/values?year=${next.year}&month=${next.month}`).catch(() => null),
      api<Preview>(`/api/recognition/preview?year=${next.year}&month=${next.month}`).catch(() => null),
    ]);
    setBusy(false);

    if (nextEntry && nextPreview) {
      setPeriod(nextPreview.period);
      setEntry(nextEntry);
      setPreview(nextPreview);
      setEdits({});
      setExpanded(null);
    }
  }

  async function saveValues() {
    const values = Object.entries(edits).map(([key, raw]) => {
      const [employeeId = "", parameterId = ""] = key.split(":");
      return { employeeId, parameterId, rawValue: raw.trim() === "" ? null : Number(raw) };
    });
    if (values.length === 0) return;

    // A number field can still hand back something unparseable. Refusing the
    // whole save beats sending NaN, which serialises to null and would quietly
    // erase a figure somebody meant to type.
    if (values.some((v) => v.rawValue !== null && !Number.isFinite(v.rawValue))) {
      toast.error("Some figures are not numbers", { description: "Clear them or type a number." });
      return;
    }

    setBusy(true);
    const done = await mutate(
      () =>
        api("/api/recognition/values", {
          method: "POST",
          body: { year: period.year, month: period.month, values },
        }),
      { success: "Figures saved.", error: "Nothing was saved" },
    );
    setBusy(false);

    if (done) {
      setEdits({});
      await load(period);
      router.refresh();
    }
  }

  function valueOf(row: EntryRow, parameterId: string): string {
    const key = `${row.employeeId}:${parameterId}`;
    if (key in edits) return edits[key] ?? "";
    const stored = row.values[parameterId];
    return stored == null ? "" : String(stored);
  }

  return (
    <div className="space-y-4">
      {/* ---------- the month ---------- */}
      <Section
        title="The month"
        description="A month is scored once it is over and every figure is in."
        action={
          <Select
            className="max-w-56"
            aria-label="Month to score"
            value={`${period.year}-${period.month}`}
            disabled={busy}
            onChange={(e) => {
              const [year = "", month = ""] = e.target.value.split("-");
              void load({ year: Number(year), month: Number(month) });
            }}
          >
            {months.map((m) => (
              <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>
                {MONTH_NAMES[m.month - 1]} {m.year}
              </option>
            ))}
          </Select>
        }
      >
        <div className="flex flex-wrap items-center gap-2 p-4">
          {published ? (
            <Badge tone="success">
              <CheckCircle2 className="size-3" aria-hidden />
              Published
            </Badge>
          ) : (
            <Badge tone="neutral">Draft — nobody else can see this</Badge>
          )}
          <Badge tone="outline">{pluralise(preview.ranked.length, "person")} eligible</Badge>
          {preview.excluded.length > 0 ? (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => setShowExcluded((s) => !s)}
            >
              {preview.excluded.length} not eligible
            </button>
          ) : null}
        </div>

        {showExcluded && preview.excluded.length > 0 ? (
          <ul className="divide-y divide-border border-t border-border">
            {preview.excluded.map((row) => (
              <li key={row.employeeId} className="flex items-center gap-3 px-4 py-2">
                <UserMinus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm">{row.name}</span>
                <span className="text-xs text-muted-foreground">{row.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      {/* ---------- figures to type in ---------- */}
      {entry.parameters.length > 0 ? (
        <Section
          title="This month's figures"
          description="Only the measures the app cannot count for itself."
          action={
            entry.editable ? (
              <Button
                size="sm"
                loading={busy}
                disabled={busy || Object.keys(edits).length === 0}
                onClick={() => void saveValues()}
              >
                Save figures
              </Button>
            ) : undefined
          }
        >
          {entry.rows.length === 0 ? (
            <EmptyState title="Nobody was eligible for this month" />
          ) : (
            <>
              {!entry.editable ? (
                <div className="px-4 pt-4">
                  <Alert tone="info">
                    {period.label} has been published, so its figures can no longer be changed.
                  </Alert>
                </div>
              ) : null}
              <TableWrap>
                <Table>
                  <THead>
                    <tr>
                      <TH>Employee</TH>
                      {entry.parameters.map((parameter) => (
                        <TH key={parameter.id} numeric>
                          {parameter.name}
                        </TH>
                      ))}
                    </tr>
                  </THead>
                  <TBody>
                    {entry.rows.map((row) => (
                      <TR key={row.employeeId}>
                        <TD>
                          <span className="block truncate text-sm font-medium">{row.name}</span>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {row.employeeCode}
                          </span>
                        </TD>
                        {entry.parameters.map((parameter) => (
                          <TD key={parameter.id} numeric>
                            <Input
                              type="number"
                              step="any"
                              className="ml-auto h-9 max-w-32 text-right"
                              aria-label={`${parameter.name} for ${row.name}`}
                              disabled={!entry.editable || busy}
                              value={valueOf(row, parameter.id)}
                              onChange={(e) =>
                                setEdits((current) => ({
                                  ...current,
                                  [`${row.employeeId}:${parameter.id}`]: e.target.value,
                                }))
                              }
                            />
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableWrap>
            </>
          )}
        </Section>
      ) : null}

      {/* ---------- the draft ranking ---------- */}
      <Section
        title="The draft ranking"
        description="Every figure placed on a 0–1 scale across everybody eligible, then weighted."
        action={
          !published ? (
            <Button
              size="sm"
              disabled={!preview.canPublish || preview.ranked.length === 0}
              onClick={() => setPublishing(true)}
            >
              <Send className="size-4" aria-hidden />
              Publish
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-3 p-4">
          {/* The published record is frozen; this table is not. Saying so beats
              letting somebody read a recomputation as the published result. */}
          {published ? (
            <Alert tone="info" title={`${period.label} is published`}>
              This table is computed from today&rsquo;s data and today&rsquo;s weights, so it can
              differ from what was published. What everybody else sees is on the Employee of the
              Month page.
            </Alert>
          ) : null}

          {preview.blockers.length > 0 && !published ? (
            <Alert tone="warning" title="Not ready to publish">
              <ul className="list-disc space-y-0.5 pl-4">
                {preview.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {/* Named, not silently scored zero — the whole point of surfacing this. */}
          {preview.incomplete.length > 0 ? (
            <Alert tone="warning" title="Some figures have not been entered">
              <ul className="mt-1 space-y-0.5">
                {preview.incomplete.slice(0, 12).map((row) => (
                  <li key={row.employeeId}>
                    <span className="font-medium">{row.name}</span> — no figure for{" "}
                    {row.parameters.join(", ")}. They score zero on it until one is entered.
                  </li>
                ))}
              </ul>
              {preview.incomplete.length > 12 ? (
                <p className="mt-1">…and {preview.incomplete.length - 12} more.</p>
              ) : null}
            </Alert>
          ) : null}

          {preview.parameters.some((p) => p.uniform) ? (
            <Alert tone="info">
              {preview.parameters
                .filter((p) => p.uniform)
                .map((p) => p.name)
                .join(", ")}{" "}
              came out the same for everybody, so everybody scored full marks on it and it decided
              nothing this month.
            </Alert>
          ) : null}
        </div>

        {preview.ranked.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title="Nothing to rank"
            description="Nobody was eligible for this month, or no measures are switched on."
          />
        ) : (
          <TableWrap>
            <Table>
              <THead>
                <tr>
                  <TH>#</TH>
                  <TH>Employee</TH>
                  {preview.parameters.map((parameter) => (
                    <TH key={parameter.id} numeric>
                      {parameter.name}
                      <span className="ml-1 font-normal text-muted-foreground">×{parameter.weight}</span>
                    </TH>
                  ))}
                  <TH numeric>Score</TH>
                  <TH />
                </tr>
              </THead>
              <TBody>
                {preview.ranked.map((row) => (
                  <TR key={row.employeeId}>
                    <TD className="text-muted-foreground">{row.rank}</TD>
                    <TD>
                      <span className="flex items-center gap-2">
                        <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[10px] font-semibold">
                          {row.photoUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={row.photoUrl} alt="" className="size-full object-cover" />
                          ) : (
                            initials(row.name)
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {row.name}
                            {row.awardsWon > 0 ? (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                {row.awardsWon}× winner
                              </span>
                            ) : null}
                          </span>
                          {row.tie ? (
                            <span className="block text-xs text-warning-text">
                              tied on {row.totalScore.toFixed(2)} —{" "}
                              {row.tie.reason ? TIE_EXPLANATION[row.tie.reason] : "ahead on the tie-break"}
                              {row.tie.parameterName ? ` (${row.tie.parameterName})` : ""}
                            </span>
                          ) : (
                            <span className="block truncate text-xs text-muted-foreground">
                              {row.designation ?? row.employeeCode}
                            </span>
                          )}
                        </span>
                      </span>
                    </TD>
                    {row.workings.map((working) => (
                      <TD key={working.parameterId} numeric>
                        <span
                          className={
                            working.missing ? "block text-sm text-warning-text" : "block text-sm"
                          }
                        >
                          {working.missing
                            ? "not entered"
                            : formatRecognitionValue(working.raw, working.unit, currency)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {working.normalised.toFixed(3)} × {working.weight} ={" "}
                          {working.contribution.toFixed(2)}
                        </span>
                      </TD>
                    ))}
                    <TD numeric className="font-semibold">
                      {row.totalScore.toFixed(2)}
                    </TD>
                    <TD>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`How ${row.name}'s score was reached`}
                        aria-expanded={expanded === row.employeeId}
                        onClick={() =>
                          setExpanded((current) => (current === row.employeeId ? null : row.employeeId))
                        }
                      >
                        <ChevronDown className="size-4" aria-hidden />
                      </button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        )}

        {/* The long form of one person's arithmetic, for when a table of numbers
            is not enough to settle an argument. */}
        {expandedRow ? (
          <Workings row={expandedRow} parameters={preview.parameters} currency={currency} />
        ) : null}
      </Section>

      <PublishDialog
        // Remounted per month, so the winner it has selected is always one of
        // the people actually on screen.
        key={`${period.year}-${period.month}`}
        open={publishing}
        onOpenChange={setPublishing}
        period={period}
        preview={preview}
        aiAvailable={aiAvailable}
        onPublished={async () => {
          setPublishing(false);
          await load(period);
          router.refresh();
        }}
      />
    </div>
  );
}

function Workings({
  row,
  parameters,
  currency,
}: {
  row: RankedRow;
  parameters: Preview["parameters"];
  currency: string;
}) {
  return (
    <div className="border-t border-border bg-muted/30 p-4">
      <p className="text-sm font-medium">{row.name}, step by step</p>
      <ul className="mt-2 space-y-2 text-sm">
        {row.workings.map((working) => {
          const parameter = parameters.find((p) => p.id === working.parameterId);
          return (
            <li key={working.parameterId}>
              <span className="font-medium">{working.parameterName}</span>{" "}
              <span className="text-muted-foreground">
                {working.missing ? (
                  <>
                    — no figure was entered, so it scores 0 of a possible {working.weight}.
                  </>
                ) : working.uniform ? (
                  <>
                    — everybody had {formatRecognitionValue(working.raw, working.unit, currency)}, so
                    everybody scores the full {working.weight}.
                  </>
                ) : (
                  <>
                    — {formatRecognitionValue(working.raw, working.unit, currency)} against a range of{" "}
                    {formatRecognitionValue(parameter?.min ?? null, working.unit, currency)} to{" "}
                    {formatRecognitionValue(parameter?.max ?? null, working.unit, currency)}
                    {working.direction === "LOWER_IS_BETTER" ? " (lower is better)" : ""} gives{" "}
                    {working.normalised.toFixed(3)}, × {working.weight} ={" "}
                    {working.contribution.toFixed(2)}.
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-sm">
        Total <span className="font-semibold">{row.totalScore.toFixed(2)}</span> out of 100
        {row.presentDays > 0 ? ` · ${pluralise(row.presentDays, "day")} present` : ""}.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ publish */

function PublishDialog({
  open,
  onOpenChange,
  period,
  preview,
  aiAvailable,
  onPublished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  period: Period;
  preview: Preview;
  aiAvailable: boolean;
  onPublished: () => Promise<void>;
}) {
  const top = preview.ranked[0];
  const [winnerId, setWinnerId] = useState(top?.employeeId ?? "");
  const [reason, setReason] = useState("");
  const [citation, setCitation] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);

  const overriding = Boolean(top) && winnerId !== top?.employeeId;
  const chosen = preview.ranked.find((r) => r.employeeId === winnerId);
  const ready = Boolean(chosen) && (!overriding || reason.trim().length >= 10);

  async function draftCitation() {
    setDrafting(true);
    const result = await mutate<{ citation: string }>(
      () =>
        api("/api/recognition/ai", {
          method: "POST",
          body: { kind: "citation", year: period.year, month: period.month, employeeId: winnerId },
        }),
      { error: "Nothing was drafted" },
    );
    setDrafting(false);
    if (result) setCitation(result.citation);
  }

  async function publish() {
    setBusy(true);
    const done = await mutate(
      () =>
        api("/api/recognition/publish", {
          method: "POST",
          body: {
            year: period.year,
            month: period.month,
            winnerEmployeeId: winnerId,
            overrideReason: overriding ? reason.trim() : undefined,
            citation: citation.trim() || undefined,
          },
        }),
      { success: `${period.label} published.`, error: "It was not published" },
    );
    setBusy(false);
    if (done) await onPublished();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish {period.label}</DialogTitle>
          <DialogDescription>
            This makes the result visible to everybody in the organisation and notifies the winner.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <Field label="Winner" htmlFor="winner" hint="The top score is selected. Changing it needs a reason.">
            <Select id="winner" value={winnerId} onChange={(e) => setWinnerId(e.target.value)}>
              {preview.ranked.map((row) => (
                <option key={row.employeeId} value={row.employeeId}>
                  {row.rank}. {row.name} — {row.totalScore.toFixed(2)}
                </option>
              ))}
            </Select>
          </Field>

          {overriding ? (
            <>
              <Alert tone="warning" title="You are choosing somebody other than the top score">
                <span className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    {top?.name} scored {top?.totalScore.toFixed(2)} and {chosen?.name} scored{" "}
                    {chosen?.totalScore.toFixed(2)}. Your reason is recorded and shown on the award.
                  </span>
                </span>
              </Alert>
              <Field
                label="Why"
                htmlFor="override-reason"
                required
                hint="Everybody who sees the award sees this. An unexplained override is worse than none."
              >
                <Textarea
                  id="override-reason"
                  rows={3}
                  maxLength={600}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </>
          ) : null}

          <Field
            label="Citation"
            htmlFor="citation"
            hint="A sentence or two read out with the award. Optional."
          >
            <Textarea
              id="citation"
              rows={4}
              maxLength={2000}
              value={citation}
              onChange={(e) => setCitation(e.target.value)}
            />
          </Field>

          {aiAvailable ? (
            <Button
              size="sm"
              variant="secondary"
              loading={drafting}
              disabled={drafting || !winnerId}
              onClick={() => void draftCitation()}
            >
              <Sparkles className="size-4" aria-hidden />
              Draft one from their figures
            </Button>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button loading={busy} disabled={!ready || busy} onClick={() => void publish()}>
            Publish {period.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
