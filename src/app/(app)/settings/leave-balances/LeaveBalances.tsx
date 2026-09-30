"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  CalendarClock,
  CircleAlert,
  Redo2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Section, Stat, StatGrid } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
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
import { cn, pluralise } from "@/lib/utils";
import type {
  BalanceCell,
  BalanceGrid,
  BalanceRow,
  BalanceTypeRow,
  CarryForwardRunRow,
  CarryForwardSummary,
} from "@/services/leave/balances";

/**
 * The balance grid, one adjustment at a time, and the year-end run.
 *
 * Every cell is a button. An administrator arrives here because one person's
 * figure is wrong, and the shortest path from seeing the wrong number to fixing
 * it is clicking on it — a separate "adjust" form asking again who and which
 * type is a form they have already filled in by finding the row.
 *
 * The year-end run is deliberately two steps and the confirm button carries the
 * numbers rather than the word "Confirm". A run that quietly doubled everybody's
 * balance is the failure mode this screen exists to prevent, and the defence is
 * partly in the service — the write sets rather than increments — and partly
 * here, in never letting somebody start it without first seeing how many people
 * and how many days move.
 */

interface AdjustDraft {
  row: BalanceRow;
  type: BalanceTypeRow;
  cell: BalanceCell;
  /**
   * `null` is an empty box, and an empty box is left alone rather than sent.
   * These two figures were strings parsed with `Number()`, so clearing one and
   * saving wrote a zero over somebody's allocation.
   */
  allocated: number | null;
  carriedForward: number | null;
  reason: string;
}

/** Days read better as 12 and 12.5 than as 12.00. */
function days(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Leave is stored to two decimals; anything smaller is a rounding artefact. */
function differs(a: number, b: number): boolean {
  return Math.abs(a - b) > 0.001;
}

export function LeaveBalances({ initial }: { initial: BalanceGrid }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<AdjustDraft | null>(null);

  const columns = data.filters.leaveTypeId
    ? data.types.filter((t) => t.id === data.filters.leaveTypeId)
    : data.types;

  async function load(next: { year?: number; employeeId?: string | null; leaveTypeId?: string | null }) {
    const params = new URLSearchParams();
    params.set("year", String(next.year ?? data.year));
    const employeeId = next.employeeId === undefined ? data.filters.employeeId : next.employeeId;
    const leaveTypeId = next.leaveTypeId === undefined ? data.filters.leaveTypeId : next.leaveTypeId;
    if (employeeId) params.set("employeeId", employeeId);
    if (leaveTypeId) params.set("leaveTypeId", leaveTypeId);

    setBusy(true);
    const grid = await mutate<BalanceGrid>(
      () => api(`/api/settings/leave-balances?${params.toString()}`),
      { error: "The balances could not be loaded" },
    );
    setBusy(false);
    if (grid) setData(grid);
  }

  async function saveAdjustment() {
    if (!draft) return;

    const { allocated, carriedForward } = draft;
    // Only what actually moved is sent, so the audit row says what somebody
    // changed rather than what the form happened to be holding.
    const body: Record<string, unknown> = {
      employeeId: draft.row.employeeId,
      leaveTypeId: draft.type.id,
      year: data.year,
      reason: draft.reason.trim(),
      filters: {
        year: data.year,
        ...(data.filters.employeeId ? { employeeId: data.filters.employeeId } : {}),
        ...(data.filters.leaveTypeId ? { leaveTypeId: data.filters.leaveTypeId } : {}),
      },
    };
    if (allocated !== null && differs(allocated, draft.cell.allocated)) body.allocated = allocated;
    if (carriedForward !== null && differs(carriedForward, draft.cell.carriedForward)) {
      body.carriedForward = carriedForward;
    }

    setBusy(true);
    const grid = await mutate<BalanceGrid>(
      () => api("/api/settings/leave-balances", { method: "POST", body }),
      { success: "Balance adjusted.", error: "Nothing was changed" },
    );
    setBusy(false);
    if (grid) {
      setData(grid);
      setDraft(null);
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <Section
        title="Balances"
        description={`${pluralise(data.total, "person")} · figures are days available to take.`}
        action={
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Year" htmlFor="balance-year">
              <Select
                id="balance-year"
                className="h-9 w-28"
                value={String(data.year)}
                disabled={busy}
                onChange={(e) => void load({ year: Number(e.target.value) })}
              >
                {data.years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Employee" htmlFor="balance-employee">
              <Select
                id="balance-employee"
                className="h-9 w-48"
                value={data.filters.employeeId ?? ""}
                disabled={busy}
                onChange={(e) => void load({ employeeId: e.target.value || null })}
              >
                <option value="">Everybody</option>
                {data.employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.code} — {employee.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Leave type" htmlFor="balance-type">
              <Select
                id="balance-type"
                className="h-9 w-40"
                value={data.filters.leaveTypeId ?? ""}
                disabled={busy}
                onChange={(e) => void load({ leaveTypeId: e.target.value || null })}
              >
                <option value="">All types</option>
                {data.types.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        }
      >
        {data.truncated ? (
          <div className="border-b border-border p-4">
            <Alert tone="info">
              Showing the first {data.rows.length} of {pluralise(data.total, "person")}. Pick
              somebody from the list above to find one person quickly.
            </Alert>
          </div>
        ) : null}

        <ResponsiveList
          items={data.rows}
          empty={
            <EmptyState
              title="Nobody to show"
              description="No active employee had joined by the end of this year."
            />
          }
          head={
            <>
              <TH>Employee</TH>
              {columns.map((type) => (
                <TH key={type.id} numeric>
                  <span className="block">{type.name}</span>
                  <span className="block font-normal text-muted-foreground">
                    {type.accrues ? "accrues monthly" : `${days(type.annualAllocation)} a year`}
                  </span>
                </TH>
              ))}
            </>
          }
          row={(row) => (
            <TR key={row.employeeId}>
              <TD>
                <span className="flex items-center gap-1.5 font-medium">
                  {row.name}
                  {row.self ? <Badge tone="neutral">you</Badge> : null}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {row.employeeCode}
                  {row.department ? ` · ${row.department}` : ""}
                </span>
              </TD>
              {columns.map((type) => {
                const cell = row.cells.find((c) => c.leaveTypeId === type.id);
                return (
                  <TD key={type.id} numeric className="px-2">
                    {cell ? (
                      <CellButton
                        row={row}
                        type={type}
                        cell={cell}
                        year={data.year}
                        onOpen={setDraft}
                      />
                    ) : (
                      "—"
                    )}
                  </TD>
                );
              })}
            </TR>
          )}
          card={(row) => (
            <div className="space-y-2">
              <div>
                <p className="flex items-center gap-1.5 font-medium">
                  {row.name}
                  {row.self ? <Badge tone="neutral">you</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.employeeCode}
                  {row.department ? ` · ${row.department}` : ""}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {columns.map((type) => {
                  const cell = row.cells.find((c) => c.leaveTypeId === type.id);
                  if (!cell) return null;
                  return (
                    <div key={type.id} className="rounded-md border border-border p-2">
                      <p className="text-xs text-muted-foreground">{type.name}</p>
                      <CellButton
                        row={row}
                        type={type}
                        cell={cell}
                        year={data.year}
                        onOpen={setDraft}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        />

        <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
          The large figure is what is left to take. Choose a cell to change the allocation or the
          days carried in from last year — leave already taken is never edited here, because it is
          the sum of approved requests and typing over it would make the two disagree. Your own row
          is shown but not adjustable: somebody else with this permission has to change your
          balance, the same way they have to approve your leave.
        </p>
      </Section>

      <YearEndRun grid={data} onRan={(toYear) => void load({ year: toYear })} />

      <CarryForwardHistory />

      <AdjustDialog
        draft={draft}
        year={data.year}
        busy={busy}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSave={saveAdjustment}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  One cell                                                                   */
/* -------------------------------------------------------------------------- */

function CellButton({
  row,
  type,
  cell,
  year,
  onOpen,
}: {
  row: BalanceRow;
  type: BalanceTypeRow;
  cell: BalanceCell;
  year: number;
  onOpen: (draft: AdjustDraft) => void;
}) {
  // Only paid types move `used`, so an unpaid type showing more approved days
  // than used days is correct rather than a discrepancy.
  const mismatch = type.paid && differs(cell.used, cell.approved);

  const figures = (
    <>
      <span
        className={cn(
          "tabular block font-medium",
          cell.available < 0 && "text-danger-text",
          !cell.stored && "text-muted-foreground",
        )}
      >
        {days(cell.available)}
      </span>
      <span className="tabular block text-xs text-muted-foreground">
        {cell.stored ? (
          <>
            {days(cell.used)} used
            {cell.carriedForward > 0 ? ` · ${days(cell.carriedForward)} c/f` : ""}
          </>
        ) : (
          "not set"
        )}
        {mismatch ? (
          <CircleAlert
            className="ml-1 inline size-3 text-danger-text"
            role="img"
            aria-label={`Recorded as ${days(cell.used)} used, but ${days(
              cell.approved,
            )} days of leave were approved`}
          />
        ) : null}
      </span>
    </>
  );

  // `adjustBalance` refuses the caller's own row, so it is shown rather than
  // offered. A control whose only possible outcome is a refusal is how people
  // learn to click past refusals.
  if (row.self) {
    return (
      <span
        className="block w-full px-2 py-1 text-right"
        title="You cannot adjust your own leave balance."
      >
        {figures}
      </span>
    );
  }

  return (
    <button
      type="button"
      className="w-full rounded-md px-2 py-1 text-right hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() =>
        onOpen({
          row,
          type,
          cell,
          allocated: cell.allocated,
          carriedForward: cell.carriedForward,
          reason: "",
        })
      }
      aria-label={`Adjust ${type.name} for ${row.name} in ${year}. ${days(
        cell.available,
      )} days available${cell.stored ? "" : ", no balance recorded yet"}.`}
    >
      {figures}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Adjusting                                                                  */
/* -------------------------------------------------------------------------- */

function AdjustDialog({
  draft,
  year,
  busy,
  onChange,
  onClose,
  onSave,
}: {
  draft: AdjustDraft | null;
  year: number;
  busy: boolean;
  onChange: (draft: AdjustDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const changed =
    draft != null &&
    ((draft.allocated !== null && differs(draft.allocated, draft.cell.allocated)) ||
      (draft.carriedForward !== null &&
        differs(draft.carriedForward, draft.cell.carriedForward)));
  const ready = changed && (draft?.reason.trim().length ?? 0) >= 5;
  const mismatch = draft != null && draft.type.paid && differs(draft.cell.used, draft.cell.approved);

  return (
    <Dialog open={draft != null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {draft ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {draft.type.name} — {draft.row.name}
              </DialogTitle>
              <DialogDescription>
                {draft.row.employeeCode} · {year}
                {draft.cell.stored ? "" : " · no balance recorded yet, so this creates one"}
              </DialogDescription>
            </DialogHeader>

            <DialogBody className="space-y-4">
              <dl className="grid grid-cols-3 gap-2 rounded-md border border-border p-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Taken</dt>
                  <dd className="tabular font-medium">{days(draft.cell.used)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Encashed</dt>
                  <dd className="tabular font-medium">{days(draft.cell.encashed)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Available</dt>
                  <dd
                    className={cn(
                      "tabular font-medium",
                      draft.cell.available < 0 && "text-danger-text",
                    )}
                  >
                    {days(draft.cell.available)}
                  </dd>
                </div>
              </dl>

              {mismatch ? (
                <Alert tone="warning" title="This balance and the leave register disagree">
                  {days(draft.cell.used)} day(s) are recorded as taken, but {days(draft.cell.approved)}{" "}
                  day(s) of {draft.type.name} were approved in {year}. Days taken are not editable
                  here — they follow approvals — so the request itself is where to look.
                </Alert>
              ) : null}

              {draft.type.accrues ? (
                <Alert tone="info">
                  {draft.type.name} accrues month by month, so what is available comes from days
                  accrued so far. The allocation below is the annual ceiling accrual stops at.
                </Alert>
              ) : null}

              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                <Field
                  label="Allocated"
                  htmlFor="adjust-allocated"
                  hint={`Normally ${days(draft.type.annualAllocation)} for this type.`}
                >
                  <NumberField
                    id="adjust-allocated"
                    min={0}
                    decimals={1}
                    value={draft.allocated}
                    onValueChange={(allocated) => onChange({ ...draft, allocated })}
                  />
                </Field>
                <Field
                  label="Carried forward"
                  htmlFor="adjust-carried"
                  hint={
                    draft.type.carryForward
                      ? `The year-end run caps this at ${days(draft.type.maxCarryForward)}.`
                      : "This type does not normally carry forward."
                  }
                >
                  <NumberField
                    id="adjust-carried"
                    min={0}
                    decimals={1}
                    value={draft.carriedForward}
                    onValueChange={(carriedForward) => onChange({ ...draft, carriedForward })}
                  />
                </Field>
              </div>

              <Field
                label="Reason"
                htmlFor="adjust-reason"
                required
                hint="Goes in the audit log. It is the only explanation anybody will find later."
              >
                <Textarea
                  id="adjust-reason"
                  value={draft.reason}
                  placeholder="Opening balance agreed on joining, 4 days short in the migration."
                  onChange={(e) => onChange({ ...draft, reason: e.target.value })}
                />
              </Field>
            </DialogBody>

            <DialogFooter>
              <Button variant="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={onSave} disabled={!ready} loading={busy}>
                {changed ? "Save adjustment" : "Nothing changed yet"}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  The year-end run                                                           */
/* -------------------------------------------------------------------------- */

const PREVIEW_LINES = 40;

function YearEndRun({ grid, onRan }: { grid: BalanceGrid; onRan: (toYear: number) => void }) {
  const router = useRouter();
  const [fromYear, setFromYear] = useState(grid.thisYear - 1);
  const [preview, setPreview] = useState<CarryForwardSummary | null>(null);
  const [done, setDone] = useState<CarryForwardSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const toYear = fromYear + 1;
  const options = [grid.thisYear - 3, grid.thisYear - 2, grid.thisYear - 1, grid.thisYear];

  async function run(commit: boolean) {
    setBusy(true);
    const summary = await mutate<CarryForwardSummary>(
      () =>
        api("/api/settings/leave-balances/carry-forward", {
          method: "POST",
          body: { fromYear, toYear, commit },
        }),
      commit
        ? { success: "Carry-forward complete.", error: "The run did not finish" }
        : { error: "The preview could not be built" },
    );
    setBusy(false);
    if (!summary) return;

    if (commit) {
      setDone(summary);
      setPreview(null);
      onRan(summary.toYear);
      router.refresh();
    } else {
      setPreview(summary);
      setDone(null);
    }
  }

  const moving = preview?.lines.filter((line) => line.action !== "UNCHANGED") ?? [];

  return (
    <Section
      title="Year-end carry-forward"
      description="Works out what each person has left, caps it at the leave type's limit, and writes it as next year's opening balance."
    >
      <div className="space-y-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Carry forward from" htmlFor="carry-from">
            <Select
              id="carry-from"
              className="h-9 w-32"
              value={String(fromYear)}
              disabled={busy}
              onChange={(e) => {
                setFromYear(Number(e.target.value));
                // A preview belongs to the year it was built for. Keeping it on
                // screen after the year changed is how somebody confirms a run
                // they never actually looked at.
                setPreview(null);
                setDone(null);
              }}
            >
              {options.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-center gap-2 pb-2 text-sm text-muted-foreground">
            <ArrowRight className="size-4" aria-hidden />
            <span>into {toYear}</span>
          </div>
          <Button variant="secondary" onClick={() => void run(false)} loading={busy} className="mb-0">
            Preview the run
          </Button>
        </div>

        {done ? (
          <Alert tone="success" title={`${done.fromYear} closed into ${done.toYear}`}>
            {pluralise(done.employees, "person")} had days carried forward, {days(done.days)} in
            total. {done.lapsed > 0 ? `${days(done.lapsed)} day(s) lapsed at the caps.` : ""}
          </Alert>
        ) : null}

        {preview ? (
          <div className="space-y-3">
            <StatGrid>
              <Stat
                label="People affected"
                value={preview.employees}
                hint={`of ${pluralise(preview.considered, "person")}`}
                icon={CalendarClock}
                tone="primary"
              />
              <Stat label="Days carried" value={days(preview.days)} hint={`into ${toYear}`} />
              <Stat
                label="Days lapsing"
                value={days(preview.lapsed)}
                hint="above the type's cap"
                tone={preview.lapsed > 0 ? "warning" : "neutral"}
              />
              <Stat
                label="Already correct"
                value={preview.unchanged}
                hint="balances the run would not touch"
              />
            </StatGrid>

            {preview.employees === 0 ? (
              <Alert tone="info">
                Nothing to do. Every {toYear} opening balance already matches what {fromYear} closed
                with, so running this would write exactly what is already there.
              </Alert>
            ) : (
              <Alert tone="warning" title={`This writes ${toYear} opening balances`}>
                Days carried in are <strong>set</strong> from what {fromYear} closed with, never
                added to what is already recorded — so running this a second time changes nothing.
                Leave already taken in {toYear} is untouched.
              </Alert>
            )}

            {preview.skipped.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Not included:{" "}
                {preview.skipped.map((type, i) => (
                  <span key={type.code}>
                    {i > 0 ? "; " : ""}
                    <strong className="font-medium">{type.name}</strong> — {type.reason}
                  </span>
                ))}
              </p>
            ) : null}

            {moving.length > 0 ? (
              <div className="rounded-md border border-border">
                <ResponsiveList
                  items={moving.slice(0, PREVIEW_LINES)}
                  empty={<EmptyState title="Nothing moves" />}
                  head={
                    <>
                      <TH>Employee</TH>
                      <TH>Leave type</TH>
                      <TH numeric>Unused</TH>
                      <TH numeric>Carries</TH>
                      <TH numeric>Lapses</TH>
                      <TH numeric>Now</TH>
                    </>
                  }
                  row={(line) => (
                    <TR key={`${line.employeeId}-${line.leaveTypeId}`}>
                      <TD>
                        <span className="block">{line.employeeName}</span>
                        <span className="block text-xs text-muted-foreground">
                          {line.employeeCode}
                        </span>
                      </TD>
                      <TD>{line.typeName}</TD>
                      <TD numeric>{days(line.unused)}</TD>
                      <TD numeric className="font-medium">
                        {days(line.carried)}
                      </TD>
                      <TD numeric className={cn(line.lapsed > 0 && "text-warning-text")}>
                        {days(line.lapsed)}
                      </TD>
                      <TD numeric>
                        {line.action === "CREATE" ? (
                          <Badge tone="neutral">new</Badge>
                        ) : (
                          days(line.current)
                        )}
                      </TD>
                    </TR>
                  )}
                  card={(line) => (
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{line.employeeName}</p>
                        <p className="text-xs text-muted-foreground">
                          {line.typeName} · {days(line.unused)} unused
                          {line.lapsed > 0 ? ` · ${days(line.lapsed)} lapses` : ""}
                        </p>
                      </div>
                      <span className="tabular shrink-0 font-medium">
                        {days(line.current)} → {days(line.carried)}
                      </span>
                    </div>
                  )}
                />
                {moving.length > PREVIEW_LINES ? (
                  <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                    and {moving.length - PREVIEW_LINES} more.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void run(true)}
                loading={busy}
                disabled={preview.employees === 0}
              >
                Carry {days(preview.days)} day(s) forward for{" "}
                {pluralise(preview.employees, "person", "people")}
              </Button>
              <Button variant="ghost" onClick={() => setPreview(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Nothing is written until you have seen the preview and pressed the button under it.
              Types that do not carry forward, and days above a type&rsquo;s cap, are left behind —
              the preview names both.
            </span>
          </p>
        )}
      </div>
    </Section>
  );
}

/**
 * The runs that have happened, and taking one back.
 *
 * `runCarryForward` writes with `set` rather than `increment`, which makes a
 * re-run harmless and made an undo impossible: the old figure was gone the
 * moment the new one landed. Every line's prior value is now recorded with the
 * run, so the last three can be taken back and put back again.
 *
 * The refusal matters more than the button. If a balance has changed since the
 * run -- a correction, or a later run over the top -- reversing this one would
 * silently overwrite that change with a figure from before it happened, so it
 * stops and names the people instead.
 */
function CarryForwardHistory() {
  const [runs, setRuns] = useState<CarryForwardRunRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void api<{ runs: CarryForwardRunRow[] }>("/api/settings/leave-balances/carry-forward")
      .then((r) => setRuns(r.runs))
      .catch(() => setRuns([]));
  }, []);

  useEffect(load, [load]);

  async function reverse(runId: string, direction: "UNDO" | "REDO") {
    setBusy(runId);
    const result = await mutate<{ runs: CarryForwardRunRow[] }>(
      () =>
        api("/api/settings/leave-balances/carry-forward", {
          method: "POST",
          body: { runId, direction },
        }),
      {
        success: direction === "UNDO" ? "Run undone." : "Run put back.",
        error: direction === "UNDO" ? "That run could not be undone" : "That run could not be put back",
      },
    );
    setBusy(null);
    if (result) setRuns(result.runs);
  }

  if (runs === null || runs.length === 0) return null;

  return (
    <Section
      title="Carry-forward runs"
      description="What has been carried, and by whom. The last three can be taken back and put back again."
    >
      <ul className="divide-y divide-border">
        {runs.map((run) => (
          <li key={run.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {run.fromYear} &rarr; {run.toYear}
                {run.undoneAt ? (
                  <Badge tone="warning" className="ml-2">
                    Undone
                  </Badge>
                ) : null}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {days(run.days)} day(s) for {pluralise(run.employees, "person", "people")} &middot;{" "}
                {new Date(run.ranAt).toLocaleDateString("en-IN")}
                {run.ranBy ? ` · ${run.ranBy}` : ""}
              </p>
            </div>
            {run.reversible ? (
              <Button
                size="sm"
                variant="secondary"
                loading={busy === run.id}
                onClick={() => void reverse(run.id, run.undoneAt ? "REDO" : "UNDO")}
              >
                {run.undoneAt ? (
                  <>
                    <Redo2 className="size-4" aria-hidden />
                    Put it back
                  </>
                ) : (
                  <>
                    <Undo2 className="size-4" aria-hidden />
                    Undo
                  </>
                )}
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">Closed</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
