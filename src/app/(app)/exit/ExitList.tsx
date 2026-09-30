"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserMinus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select, Textarea } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import { formatDate, formatMoney } from "@/lib/utils";

export interface ExitItem {
  id: string;
  type: string;
  status: "INITIATED" | "NOTICE_PERIOD" | "CLEARANCE" | "SETTLED" | "CANCELLED";
  resignationDate: string;
  lastWorkingDay: string;
  noticeDaysRequired: number;
  noticeDaysServed: number;
  noticeShortfallDays: number;
  daysRemaining: number;
  employee: { id: string; name: string; code: string; designation: string | null };
  checklist: { total: number; done: number };
  settlement: { id: string; status: string; netPaise: number } | null;
}

const TONE = {
  INITIATED: "info",
  NOTICE_PERIOD: "warning",
  CLEARANCE: "primary",
  SETTLED: "success",
  CANCELLED: "neutral",
} as const;

/**
 * A cancelled row is a withdrawal, not a dead end. The person is back on the
 * employee picker, and starting them again reuses this row — so it is worth
 * saying so on the row, since it otherwise looks like a record nobody can
 * touch.
 */
const WITHDRAWN = "withdrawn · can be started again";

const TYPES = [
  { value: "RESIGNATION", label: "Resignation" },
  { value: "TERMINATION", label: "Termination" },
  { value: "RETIREMENT", label: "Retirement" },
  { value: "END_OF_CONTRACT", label: "End of contract" },
  { value: "ABSCONDING", label: "Absconding" },
];

export function ExitList({ exits }: { exits: ExitItem[] }) {
  const label = (e: ExitItem) => e.type.replaceAll("_", " ").toLowerCase();

  return (
    <ResponsiveList
      items={exits}
      empty={
        <EmptyState
          icon={UserMinus}
          title="Nobody is leaving"
          description="Exits you start will be tracked here through notice, clearance and settlement."
        />
      }
      head={
        <>
          <TH>Employee</TH>
          <TH>Type</TH>
          <TH>Last day</TH>
          <TH>Notice</TH>
          <TH>Clearance</TH>
          <TH>Settlement</TH>
          <TH>Status</TH>
        </>
      }
      row={(e) => (
        <TR key={e.id}>
          <TD>
            <Link href={`/exit/${e.id}`} className="font-medium hover:underline">
              {e.employee.name}
            </Link>
            <span className="block text-xs text-muted-foreground">
              {e.employee.code}
              {e.employee.designation ? ` · ${e.employee.designation}` : ""}
            </span>
          </TD>
          <TD className="capitalize">{label(e)}</TD>
          <TD>
            {formatDate(e.lastWorkingDay)}
            {e.status !== "SETTLED" && e.status !== "CANCELLED" ? (
              <span className="block text-xs text-muted-foreground">
                {e.daysRemaining >= 0 ? `${e.daysRemaining} days left` : "already passed"}
              </span>
            ) : null}
            {e.status === "CANCELLED" ? (
              <span className="block text-xs text-muted-foreground">{WITHDRAWN}</span>
            ) : null}
          </TD>
          <TD>
            {e.noticeDaysServed}/{e.noticeDaysRequired}
            {e.noticeShortfallDays > 0 ? (
              <span className="block text-xs text-danger-text">
                {e.noticeShortfallDays} short
              </span>
            ) : null}
          </TD>
          <TD className="tabular">
            {e.checklist.done}/{e.checklist.total}
          </TD>
          <TD>
            {e.settlement ? (
              <>
                <span className="tabular">{formatMoney(e.settlement.netPaise)}</span>
                <span className="block text-xs text-muted-foreground">
                  {e.settlement.status.toLowerCase()}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </TD>
          <TD>
            <Badge tone={TONE[e.status]}>{e.status.replaceAll("_", " ").toLowerCase()}</Badge>
          </TD>
        </TR>
      )}
      card={(e) => (
        <Link href={`/exit/${e.id}`} className="block">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{e.employee.name}</p>
              <p className="text-xs text-muted-foreground">
                {e.employee.code} · leaves {formatDate(e.lastWorkingDay)}
              </p>
              <p className="text-xs text-muted-foreground">
                Clearance {e.checklist.done}/{e.checklist.total}
                {e.settlement ? ` · ${formatMoney(e.settlement.netPaise)}` : ""}
              </p>
              {e.status === "CANCELLED" ? (
                <p className="text-xs text-muted-foreground">{WITHDRAWN}</p>
              ) : null}
            </div>
            <Badge tone={TONE[e.status]}>{e.status.replaceAll("_", " ").toLowerCase()}</Badge>
          </div>
        </Link>
      )}
    />
  );
}

// ------------------------------------------------------------------ start one

export function StartExit({
  employees,
  activeCount,
}: {
  /** Active people without an open exit — the only ones who can be started. */
  employees: { id: string; name: string; code: string }[];
  /** Everyone active, so an empty picker can say which reason it is. */
  activeCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);

  const [form, setForm] = useState({
    employeeId: employees[0]?.id ?? "",
    type: "RESIGNATION",
    resignationDate: today,
    lastWorkingDay: today,
    noticeDaysRequired: 30,
    reason: "",
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const ok = await mutate(
      () =>
        api("/api/exit", {
          method: "POST",
          body: {
            employeeId: form.employeeId,
            type: form.type,
            resignationDate: form.resignationDate,
            lastWorkingDay: form.lastWorkingDay,
            noticeDaysRequired: form.noticeDaysRequired,
            ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
          },
        }),
      { success: "Exit started.", error: "That exit was not started" },
    );
    setBusy(false);
    if (ok !== null) {
      setOpen(false);
      router.refresh();
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <UserPlus className="size-4" aria-hidden />
        Start an exit
      </Button>
    );
  }

  // Nobody to pick from. The form used to open anyway — an empty dropdown and
  // a greyed-out Start with nothing to say why — so it says why instead.
  if (employees.length === 0) {
    const nobodyYet = activeCount === 0;
    return (
      <div className="w-full rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-medium">Nobody can be started right now</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {nobodyYet
            ? "There are no active employees yet. Add people to the directory first and they will appear here."
            : "Everybody active already has an exit in progress. Open theirs from the list below."}
        </p>
        <div className="mt-3 flex gap-2">
          {nobodyYet ? (
            <Button asChild variant="secondary" size="sm">
              <Link href="/employees">Open the directory</Link>
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <Field label="Employee" htmlFor="exitEmployee" required>
          <Select
            id="exitEmployee"
            value={form.employeeId}
            onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
          >
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type" htmlFor="exitType" required>
          <Select
            id="exitType"
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3">
        <Field label="Resignation date" htmlFor="exitResign" required>
          <Input
            id="exitResign"
            type="date"
            value={form.resignationDate}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                resignationDate: e.target.value,
                lastWorkingDay:
                  f.lastWorkingDay < e.target.value ? e.target.value : f.lastWorkingDay,
              }))
            }
            required
          />
        </Field>
        <Field label="Last working day" htmlFor="exitLast" required>
          <Input
            id="exitLast"
            type="date"
            min={form.resignationDate}
            value={form.lastWorkingDay}
            onChange={(e) => setForm((f) => ({ ...f, lastWorkingDay: e.target.value }))}
            required
          />
        </Field>
        <Field
          label="Notice required (days)"
          htmlFor="exitNotice"
          hint="From their contract."
        >
          <NumberField
            id="exitNotice"
            min={0}
            max={365}
            className="tabular"
            value={form.noticeDaysRequired}
            onValueChange={(v) => setForm((f) => ({ ...f, noticeDaysRequired: v ?? 0 }))}
          />
        </Field>
      </div>

      <Field label="Reason" htmlFor="exitReason" hint="Optional, kept on the record.">
        <Textarea
          id="exitReason"
          rows={2}
          value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
        />
      </Field>

      <div className="flex gap-2">
        <Button type="submit" loading={busy} disabled={!form.employeeId}>
          Start
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
