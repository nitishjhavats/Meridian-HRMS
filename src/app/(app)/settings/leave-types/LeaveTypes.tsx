"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Plus, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { NumberField } from "@/components/ui/number-field";
import { EmptyState, LoadingState } from "@/components/ui/states";
import { Section } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import type { LeaveTypeRow } from "@/services/leave/types";

/**
 * Every leave type, and whether it is paid.
 *
 * There was no screen and no service: five types were written at provisioning
 * and never touched again for the life of the tenant. An organisation whose
 * sick leave is ten days rather than eight edited the database or lived with it.
 */

type Draft = {
  id?: string;
  code: string;
  name: string;
  paid: boolean;
  annualAllocation: number | null;
  accrualMode: "ANNUAL" | "MONTHLY" | "NONE";
  monthlyAccrual: number | null;
  carryForward: boolean;
  maxCarryForward: number | null;
  allowHalfDay: boolean;
  requiresApproval: boolean;
  maxConsecutive: number | null;
  noticeDays: number | null;
  countsAsPresent: boolean;
  isWeekOff: boolean;
  maxPerMonth: number | null;
  active: boolean;
};

const BLANK: Draft = {
  code: "",
  name: "",
  paid: true,
  annualAllocation: 12,
  accrualMode: "ANNUAL",
  monthlyAccrual: 1,
  carryForward: false,
  maxCarryForward: 0,
  allowHalfDay: true,
  requiresApproval: true,
  maxConsecutive: null,
  noticeDays: 0,
  countsAsPresent: true,
  isWeekOff: false,
  maxPerMonth: null,
  active: true,
};

function toDraft(row: LeaveTypeRow): Draft {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    paid: row.paid,
    annualAllocation: row.annualAllocation,
    accrualMode: (row.accrualMode as Draft["accrualMode"]) ?? "ANNUAL",
    monthlyAccrual: row.monthlyAccrual,
    carryForward: row.carryForward,
    maxCarryForward: row.maxCarryForward,
    allowHalfDay: row.allowHalfDay,
    requiresApproval: row.requiresApproval,
    maxConsecutive: row.maxConsecutive,
    noticeDays: row.noticeDays,
    countsAsPresent: row.countsAsPresent,
    isWeekOff: row.isWeekOff,
    maxPerMonth: row.maxPerMonth,
    active: row.active,
  };
}

export function LeaveTypes({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<LeaveTypeRow[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api<{ types: LeaveTypeRow[] }>("/api/settings/leave-types")
      .then((r) => setRows(r.types))
      .catch(() => setRows([]));
  }, []);

  useEffect(load, [load]);

  function edit(field: keyof Draft, value: Draft[keyof Draft]) {
    setDraft((d) => (d ? { ...d, [field]: value } : d));
  }

  // The type that already is the on-demand week off, other than the one being
  // edited. One per organisation at most: it is the marker attendance and
  // payroll read to make a booked day a rest day, and a second bank of them
  // would draw on the same quota. The service refuses too; this is the sentence
  // appearing before Save rather than after.
  const otherWeekOff = rows?.find((r) => r.isWeekOff && r.id !== draft?.id) ?? null;

  async function save() {
    if (!draft) return;
    setBusy(true);
    const result = await mutate(
      () =>
        api("/api/settings/leave-types", {
          method: "POST",
          body: {
            ...draft,
            annualAllocation: draft.annualAllocation ?? 0,
            monthlyAccrual: draft.monthlyAccrual ?? 0,
            maxCarryForward: draft.maxCarryForward ?? 0,
            noticeDays: draft.noticeDays ?? 0,
          },
        }),
      { success: "Saved.", error: "That could not be saved" },
    );
    setBusy(false);
    if (result) {
      setDraft(null);
      load();
    }
  }

  return (
    <Section
      title="Leave types"
      description="What can be taken, how much of it, and whether it is paid. A type appears to employees only once it is switched on, and it will not switch on until the days and the frequency are set."
      action={
        canWrite ? (
          <Button size="sm" onClick={() => setDraft({ ...BLANK })}>
            <Plus className="size-4" aria-hidden />
            New leave type
          </Button>
        ) : undefined
      }
    >
      {rows === null ? (
        <LoadingState label="Loading leave types" />
      ) : (
        <ResponsiveList
          items={rows}
          empty={
            <EmptyState
              title="No leave types"
              description="Every organisation is created with a few. If this is empty, add the first one."
            />
          }
          head={
            <>
              <TH>Type</TH>
              <TH>Paid</TH>
              <TH numeric>Days a year</TH>
              <TH>Accrual</TH>
              <TH>Carry forward</TH>
              <TH />
            </>
          }
          row={(row) => (
            <TR key={row.id}>
              <TD>
                <span className="font-medium">{row.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {row.code}
                  {row.isCompOff ? " · compensatory off" : ""}
                  {row.isWeekOff ? " · on-demand week off" : ""}
                  {row.maxPerMonth !== null ? ` · at most ${row.maxPerMonth} a month` : ""}
                  {row.active ? "" : " · not switched on"}
                </span>
              </TD>
              <TD>
                <Badge tone={row.paid ? "success" : "neutral"}>{row.paid ? "Paid" : "Unpaid"}</Badge>
              </TD>
              <TD numeric className="tabular">
                {row.annualAllocation}
              </TD>
              <TD className="text-xs text-muted-foreground">
                {row.accrualMode === "MONTHLY"
                  ? `${row.monthlyAccrual} a month`
                  : row.accrualMode === "ANNUAL"
                    ? "All at once"
                    : "None"}
              </TD>
              <TD className="text-xs text-muted-foreground">
                {row.carryForward ? `Up to ${row.maxCarryForward}` : "Lapses"}
              </TD>
              <TD>
                {canWrite ? (
                  <Button size="sm" variant="ghost" onClick={() => setDraft(toDraft(row))}>
                    <Pencil className="size-4" aria-hidden />
                    Edit
                  </Button>
                ) : null}
              </TD>
            </TR>
          )}
          card={(row) => (
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{row.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.code} · {row.annualAllocation} days ·{" "}
                  {row.carryForward ? `carries up to ${row.maxCarryForward}` : "lapses"}
                  {row.isWeekOff ? " · on-demand week off" : ""}
                  {row.maxPerMonth !== null ? ` · at most ${row.maxPerMonth} a month` : ""}
                  {row.active ? "" : " · not switched on"}
                </p>
              </div>
              <Badge tone={row.paid ? "success" : "neutral"}>{row.paid ? "Paid" : "Unpaid"}</Badge>
              {canWrite ? (
                <Button size="sm" variant="ghost" onClick={() => setDraft(toDraft(row))}>
                  <Pencil className="size-4" aria-hidden />
                </Button>
              ) : null}
            </div>
          )}
        />
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{draft?.id ? draft.name : "New leave type"}</DialogTitle>
          </DialogHeader>
          {draft ? (
            <DialogBody className="space-y-4">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="ltName" required>
                  <Input
                    id="ltName"
                    value={draft.name}
                    onChange={(e) => edit("name", e.target.value)}
                    placeholder="Bereavement Leave"
                  />
                </Field>
                <Field
                  label="Code"
                  htmlFor="ltCode"
                  required
                  hint={
                    draft.id
                      ? "Set once. It is printed on balances, exports and payroll traces that already exist."
                      : "Capitals, digits and underscores."
                  }
                >
                  <Input
                    id="ltCode"
                    value={draft.code}
                    disabled={Boolean(draft.id)}
                    className="font-mono uppercase"
                    onChange={(e) => edit("code", e.target.value.toUpperCase())}
                    placeholder="BL"
                  />
                </Field>
              </div>

              <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">This leave is paid</p>
                  <p className="text-xs text-muted-foreground">
                    An unpaid type spends no balance and is deducted from the month.
                  </p>
                </div>
                <Switch
                  checked={draft.paid}
                  aria-label="This leave is paid"
                  onCheckedChange={(on) => edit("paid", on)}
                />
              </div>

              <div className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">This is the on-demand week off</p>
                  <p className="text-xs text-muted-foreground">
                    {otherWeekOff
                      ? `${otherWeekOff.name} (${otherWeekOff.code}) is already the on-demand week off; switch it off there first.`
                      : "A day booked against it is a rest day on the attendance record, not paid leave, and counts towards the week-off quota. Pattern rest days are never charged to it."}
                  </p>
                </div>
                <Switch
                  checked={draft.isWeekOff}
                  disabled={Boolean(otherWeekOff)}
                  aria-label="This is the on-demand week off"
                  onCheckedChange={(on) => edit("isWeekOff", on)}
                />
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                <Field label="Days a year" htmlFor="ltDays">
                  <NumberField
                    id="ltDays"
                    min={0}
                    max={365}
                    decimals={2}
                    className="tabular"
                    value={draft.annualAllocation}
                    onValueChange={(v) => edit("annualAllocation", v)}
                  />
                </Field>
                <Field label="Granted" htmlFor="ltAccrual">
                  <Select
                    id="ltAccrual"
                    value={draft.accrualMode}
                    onChange={(e) => edit("accrualMode", e.target.value as Draft["accrualMode"])}
                  >
                    <option value="ANNUAL">All at once, at the start of the year</option>
                    <option value="MONTHLY">A little each month</option>
                    <option value="NONE">Not granted automatically</option>
                  </Select>
                </Field>
                {draft.accrualMode === "MONTHLY" ? (
                  <Field label="Days each month" htmlFor="ltMonthly">
                    <NumberField
                      id="ltMonthly"
                      min={0}
                      max={31}
                      decimals={2}
                      className="tabular"
                      value={draft.monthlyAccrual}
                      onValueChange={(v) => edit("monthlyAccrual", v)}
                    />
                  </Field>
                ) : null}
                <Field
                  label="Notice days"
                  htmlFor="ltNotice"
                  hint="How far ahead a request has to be raised."
                >
                  <NumberField
                    id="ltNotice"
                    min={0}
                    max={365}
                    className="tabular"
                    value={draft.noticeDays}
                    onValueChange={(v) => edit("noticeDays", v)}
                  />
                </Field>
                <Field
                  label="Most days in a row"
                  htmlFor="ltMax"
                  hint="Leave it empty for no limit."
                >
                  <NumberField
                    id="ltMax"
                    min={1}
                    max={365}
                    className="tabular"
                    value={draft.maxConsecutive}
                    onValueChange={(v) => edit("maxConsecutive", v)}
                  />
                </Field>
                <Field
                  label="Max a month"
                  htmlFor="ltPerMonth"
                  hint="Pending and approved together, in any one calendar month. Leave it empty for no cap."
                >
                  <NumberField
                    id="ltPerMonth"
                    min={1}
                    max={31}
                    className="tabular"
                    value={draft.maxPerMonth}
                    onValueChange={(v) => edit("maxPerMonth", v)}
                  />
                </Field>
              </div>

              <div className="space-y-2">
                {(
                  [
                    ["carryForward", "Unused days carry into next year"],
                    ["allowHalfDay", "Half days can be taken"],
                    ["requiresApproval", "A manager has to approve it"],
                    // "Counts as present in attendance reports" was here and
                    // changed nothing: `countsAsPresent` is read by no report
                    // and no grid, so the switch promised a behaviour the
                    // product does not have. Offering it would be the same
                    // defect this round is about, one round newer. Wiring it
                    // instead would flip every existing type -- the column
                    // defaults to true on all five seeded ones -- and silently
                    // change every attendance report on the instance.
                    ["active", "Available to request"],
                  ] as const
                ).map(([key, label]) => (
                  <div
                    key={key}
                    className="flex items-center gap-3 rounded-lg border border-border px-3 py-2"
                  >
                    <p className="min-w-0 flex-1 text-sm">{label}</p>
                    <Switch
                      checked={draft[key]}
                      aria-label={label}
                      onCheckedChange={(on) => edit(key, on)}
                    />
                  </div>
                ))}
              </div>

              {draft.carryForward ? (
                <Field
                  label="Most days that can carry"
                  htmlFor="ltCap"
                  hint="A cap of zero carries nothing, so this has to be above zero."
                >
                  <NumberField
                    id="ltCap"
                    min={0}
                    max={365}
                    decimals={2}
                    className="tabular"
                    value={draft.maxCarryForward}
                    onValueChange={(v) => edit("maxCarryForward", v)}
                  />
                </Field>
              ) : null}
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={save}>
              <Save className="size-4" aria-hidden />
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
