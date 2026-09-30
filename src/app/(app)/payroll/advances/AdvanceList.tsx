"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/stat";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { formatDate, formatMoney } from "@/lib/utils";

/**
 * Advances, and what is still owed on them.
 *
 * The form asks for a recovery *mode*, never an amount per month: how much
 * actually comes off depends on that month's pay and the minimum-net-pay floor,
 * and only the payroll engine knows both. Asking here would produce a number
 * that disagrees with the payslip.
 */

interface Advance {
  id: string;
  employee: { id: string; name: string; employeeCode: string };
  amountPaise: number;
  recoveredPaise: number;
  outstandingPaise: number;
  status: string;
  issuedOn: string;
  reason: string | null;
  instalmentsPaid: number;
}

const TONE: Record<string, "success" | "info" | "warning" | "neutral"> = {
  ACTIVE: "info",
  RECOVERED: "success",
  WRITTEN_OFF: "warning",
  CANCELLED: "neutral",
};

export function AdvanceList({
  initial,
  employees,
}: {
  initial: Advance[];
  employees: { id: string; name: string; employeeCode: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const active = initial.filter((a) => a.status === "ACTIVE");
  const outstanding = active.reduce((sum, a) => sum + a.outstandingPaise, 0);

  async function close(advance: Advance, status: "CANCELLED" | "WRITTEN_OFF") {
    const reason = window.prompt(
      status === "CANCELLED"
        ? `Why is ${advance.employee.name}'s advance being cancelled?`
        : `Why is ${formatMoney(advance.outstandingPaise)} being written off?`,
    );
    if (!reason) return;

    setBusy(true);
    const done = await mutate(
      () => api(`/api/payroll/advances/${advance.id}`, { method: "PATCH", body: { status, reason } }),
      {
        success: status === "CANCELLED" ? "Advance cancelled." : "Written off.",
        error: "Nothing was changed",
      },
    );
    setBusy(false);
    if (done) router.refresh();
  }

  return (
    <div className="space-y-4">
      {outstanding > 0 ? (
        <Alert tone="info" title={`${formatMoney(outstanding)} outstanding`}>
          Across {active.length} active advance{active.length === 1 ? "" : "s"}. It comes off pay
          automatically when each month is locked.
        </Alert>
      ) : null}

      <Section
        title="Advances"
        description="Issued, recovered, and written off."
        action={<IssueAdvance employees={employees} onDone={() => router.refresh()} />}
      >
        <ResponsiveList
          items={initial}
          empty={
            <EmptyState
              icon={Wallet}
              title="No advances yet"
              description="Issue one and the payroll engine recovers it from the next month's pay."
            />
          }
          head={
            <>
              <TH>Employee</TH>
              <TH>Issued</TH>
              <TH numeric>Amount</TH>
              <TH numeric>Recovered</TH>
              <TH numeric>Outstanding</TH>
              <TH>Status</TH>
              <TH> </TH>
            </>
          }
          row={(advance) => (
            <TR key={advance.id}>
              <TD>
                <span className="block font-medium">{advance.employee.name}</span>
                <span className="block text-xs text-muted-foreground">
                  {advance.employee.employeeCode}
                  {advance.reason ? ` · ${advance.reason}` : ""}
                </span>
              </TD>
              <TD className="whitespace-nowrap">{formatDate(advance.issuedOn)}</TD>
              <TD numeric>{formatMoney(advance.amountPaise)}</TD>
              <TD numeric>
                {formatMoney(advance.recoveredPaise)}
                {advance.instalmentsPaid > 0 ? (
                  <span className="block text-xs text-muted-foreground">
                    over {advance.instalmentsPaid} month{advance.instalmentsPaid === 1 ? "" : "s"}
                  </span>
                ) : null}
              </TD>
              <TD numeric>{formatMoney(advance.outstandingPaise)}</TD>
              <TD>
                <Badge tone={TONE[advance.status] ?? "neutral"}>
                  {advance.status.replaceAll("_", " ").toLowerCase()}
                </Badge>
              </TD>
              <TD>
                {advance.status === "ACTIVE" ? (
                  <span className="flex flex-wrap gap-1.5">
                    {advance.recoveredPaise === 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void close(advance, "CANCELLED")}
                      >
                        Cancel
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void close(advance, "WRITTEN_OFF")}
                    >
                      Write off
                    </Button>
                  </span>
                ) : null}
              </TD>
            </TR>
          )}
          card={(advance) => (
            <div key={advance.id} className="space-y-1 p-4">
              <p className="flex items-center justify-between gap-2 font-medium">
                {advance.employee.name}
                <Badge tone={TONE[advance.status] ?? "neutral"}>
                  {advance.status.replaceAll("_", " ").toLowerCase()}
                </Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                {formatMoney(advance.amountPaise)} issued {formatDate(advance.issuedOn)}
              </p>
              <p className="text-sm">
                {formatMoney(advance.outstandingPaise)} still owed
              </p>
            </div>
          )}
        />
      </Section>
    </div>
  );
}

function IssueAdvance({
  employees,
  onDone,
}: {
  employees: { id: string; name: string; employeeCode: string }[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [employeeId, setEmployeeId] = useState("");
  const [rupees, setRupees] = useState("");
  const [issuedOn, setIssuedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [mode, setMode] = useState<"FULL_NEXT" | "INSTALLMENTS" | "FIXED_PER_MONTH" | "PERCENT_OF_NET">(
    "FULL_NEXT",
  );
  const [installments, setInstallments] = useState(3);
  const [perMonth, setPerMonth] = useState("");
  const [percent, setPercent] = useState(20);
  const [reason, setReason] = useState("");

  // Rupees on screen, integer paise on the wire. Money never becomes a float.
  const amountPaise = Math.round(Number(rupees.replace(/[^0-9.]/g, "")) * 100);

  async function issue() {
    setBusy(true);
    const recovery =
      mode === "INSTALLMENTS"
        ? { mode, installments }
        : mode === "FIXED_PER_MONTH"
          ? { mode, amountPaise: Math.round(Number(perMonth.replace(/[^0-9.]/g, "")) * 100) }
          : mode === "PERCENT_OF_NET"
            ? { mode, percent }
            : { mode };

    const result = await mutate(
      () =>
        api("/api/payroll/advances", {
          method: "POST",
          body: { employeeId, amountPaise, issuedOn, recovery, reason: reason.trim() || undefined },
        }),
      { success: "Advance issued.", error: "It was not issued" },
    );
    setBusy(false);
    if (result) {
      setOpen(false);
      setRupees("");
      setReason("");
      onDone();
    }
  }

  const ready = employeeId !== "" && amountPaise > 0 && issuedOn !== "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Issue an advance</Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Issue a salary advance</DialogTitle>
          <DialogDescription>
            It comes off pay automatically when a month is locked, within the minimum-net-pay
            floor in your payroll rules.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <Field label="Employee" htmlFor="advEmployee" required>
            <Select id="advEmployee" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Choose somebody</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.employeeCode})
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            <Field label="Amount" htmlFor="advAmount" hint="In rupees." required>
              <Input
                id="advAmount"
                inputMode="decimal"
                placeholder="25000"
                value={rupees}
                onChange={(e) => setRupees(e.target.value)}
              />
            </Field>
            <Field label="Issued on" htmlFor="advDate" required>
              <Input
                id="advDate"
                type="date"
                value={issuedOn}
                onChange={(e) => setIssuedOn(e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="How it is recovered"
            htmlFor="advMode"
            hint="The engine works out the actual amount each month."
          >
            <Select id="advMode" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="FULL_NEXT">All of it, from the next payroll</option>
              <option value="INSTALLMENTS">In equal instalments</option>
              <option value="FIXED_PER_MONTH">A fixed amount each month</option>
              <option value="PERCENT_OF_NET">A percentage of net pay</option>
            </Select>
          </Field>

          {mode === "INSTALLMENTS" ? (
            <Field label="Number of months" htmlFor="advInstalments">
              <NumberField
                id="advInstalments"
                min={1}
                max={60}
                value={installments}
                onValueChange={(v) => setInstallments(v ?? 1)}
              />
            </Field>
          ) : null}

          {mode === "FIXED_PER_MONTH" ? (
            <Field label="Each month" htmlFor="advPerMonth" hint="In rupees.">
              <Input
                id="advPerMonth"
                inputMode="decimal"
                value={perMonth}
                onChange={(e) => setPerMonth(e.target.value)}
              />
            </Field>
          ) : null}

          {mode === "PERCENT_OF_NET" ? (
            <Field label="Percentage of net pay" htmlFor="advPercent">
              <NumberField
                id="advPercent"
                min={1}
                max={100}
                value={percent}
                onValueChange={(v) => setPercent(v ?? 1)}
              />
            </Field>
          ) : null}

          <Field label="Reason" htmlFor="advReason">
            <Input
              id="advReason"
              placeholder="Medical emergency"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button loading={busy} disabled={!ready || busy} onClick={() => void issue()}>
            Issue {amountPaise > 0 ? formatMoney(amountPaise) : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
