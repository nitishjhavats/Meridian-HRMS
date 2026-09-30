"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Package,
  Ban,
  Calculator,
  Check,
  CheckCircle2,
  Download,
  Plus,
  SkipForward,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { Section } from "@/components/ui/stat";
import { RequestFailed, api, mutate } from "@/lib/client/api";
import { openTabAfter } from "@/lib/client/openTab";
import { formatMoney } from "@/lib/utils";

/**
 * One exit, end to end.
 *
 * The order on the page is the order the work happens in: clear the checklist,
 * calculate what is owed, approve it, pay it. Each step is disabled until the
 * one before it is done, so the sequence is visible rather than something you
 * have to know.
 */

export interface ChecklistItem {
  id: string;
  title: string;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  note: string | null;
}

export interface SettlementLine {
  code: string;
  label: string;
  kind: string;
  amountPaise: number;
  formula: string | null;
}

export interface ExitDetailData {
  id: string;
  status: string;
  type: string;
  lastWorkingDay: string;
  noticeShortfallDays: number;
  checklist: ChecklistItem[];
  /** Company property issued to them and not yet returned. */
  outstandingAssets: {
    assignmentId: string;
    assetTag: string;
    name: string;
    issuedOn: string;
    acknowledged: boolean;
    valueLabel: string | null;
  }[];
  settlement: {
    id: string;
    status: string;
    earningsPaise: number;
    deductionsPaise: number;
    netPaise: number;
    paidPaise: number;
    note: string | null;
    lines: SettlementLine[];
  } | null;
}

interface Preview {
  lines: SettlementLine[];
  earningsPaise: number;
  deductionsPaise: number;
  netPaise: number;
  netInWords: string;
  yearsOfService: number;
  warnings: string[];
  problems: string[];
}

/**
 * Two permissions, two halves of the page.
 *
 * `exit.manage` runs the process: the clearance list, moving the exit along
 * and calling it off. `exit.settle` handles the money: calculating, approving
 * and paying the settlement, and the close that ends the employment. Every
 * control used to hang off `canSettle`, so an HR Manager — who holds
 * `exit.manage` and starts every exit — opened the one they had just created
 * and found nothing to press. The page is gated on `exit.manage`, which is why
 * `canManage` may be left off; it is here so the page can say it out loud.
 */
export function ExitDetail({
  exit,
  canSettle,
  canManage = true,
}: {
  exit: ExitDetailData;
  canSettle: boolean;
  canManage?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newItem, setNewItem] = useState("");
  const [payAmount, setPayAmount] = useState("");

  const openItems = exit.checklist.filter(
    (c) => c.status === "PENDING" || c.status === "IN_PROGRESS",
  );
  const settlement = exit.settlement;
  const outstanding = settlement ? settlement.netPaise - settlement.paidPaise : 0;

  async function act(key: string, path: string, body: unknown, success: string) {
    setBusy(key);
    const ok = await mutate(() => api(path, { method: "POST", body }), {
      success,
      error: "That did not work",
    });
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  async function runPreview() {
    setBusy("preview");
    setError(null);
    try {
      const result = await api<{ preview: Preview }>(`/api/exit/${exit.id}/fnf`);
      setPreview(result.preview);
    } catch (err) {
      setError(err instanceof RequestFailed ? err.error.message : "That could not be calculated.");
    } finally {
      setBusy(null);
    }
  }

  async function openStatement() {
    if (!settlement) return;
    setBusy("statement");
    try {
      await openTabAfter(
        async () => (await api<{ url: string }>(`/api/exit/settlements/${settlement.id}`)).url,
      );
    } catch (err) {
      setError(err instanceof RequestFailed ? err.error.message : "The statement is not ready.");
    } finally {
      setBusy(null);
    }
  }

  const lines = preview?.lines ?? settlement?.lines ?? [];

  return (
    <div className="space-y-4">
      {/* ---------- what they still hold ----------
          Above the clearance list on purpose. `outstandingFor` has existed in
          the assets module since it was written and was called from nowhere, so
          the exit screens never mentioned assets at all — somebody could be
          settled and paid while still holding a laptop, and the only record was
          in a module nobody opens during an exit. */}
      {exit.outstandingAssets.length > 0 ? (
        <Section
          title="Still with them"
          description={`${exit.outstandingAssets.length} item${
            exit.outstandingAssets.length === 1 ? "" : "s"
          } issued and not returned`}
        >
          <div className="space-y-3 p-4">
            <Alert tone="warning" title="Collect these before the settlement is paid">
              Returning an asset is recorded in the asset register, not here — this is the
              reminder, not the button.
            </Alert>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {exit.outstandingAssets.map((asset) => (
                <li key={asset.assignmentId} className="flex items-center gap-3 px-3 py-2">
                  <Package className="size-4 shrink-0 text-warning-text" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{asset.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {asset.assetTag} · issued {asset.issuedOn}
                      {asset.acknowledged ? "" : " · never acknowledged"}
                    </span>
                  </span>
                  {asset.valueLabel ? (
                    <span className="tabular text-sm text-muted-foreground">
                      {asset.valueLabel}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      {/* ---------- clearance ---------- */}
      <Section
        title="Clearance"
        description={`${exit.checklist.length - openItems.length} of ${exit.checklist.length} done`}
      >
        <ul className="divide-y divide-border">
          {exit.checklist.map((item) => {
            const done = item.status === "COMPLETED" || item.status === "SKIPPED";
            return (
              <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className={`text-sm ${done ? "text-muted-foreground line-through" : ""}`}>
                    {item.title}
                  </span>
                  {item.note ? (
                    <span className="block text-xs text-muted-foreground">{item.note}</span>
                  ) : null}
                </span>

                {item.status === "SKIPPED" ? <Badge tone="neutral">skipped</Badge> : null}

                {!done && canManage ? (
                  <span className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="success"
                      loading={busy === item.id}
                      onClick={() =>
                        act(
                          item.id,
                          `/api/exit/${exit.id}/checklist`,
                          { action: "set", itemId: item.id, status: "COMPLETED" },
                          "Marked done.",
                        )
                      }
                    >
                      <Check className="size-4" aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        act(
                          item.id,
                          `/api/exit/${exit.id}/checklist`,
                          { action: "set", itemId: item.id, status: "SKIPPED" },
                          "Skipped.",
                        )
                      }
                      title="Not applicable"
                    >
                      <SkipForward className="size-4" aria-hidden />
                    </Button>
                  </span>
                ) : null}

                {done && item.status === "COMPLETED" ? (
                  <CheckCircle2 className="size-4 shrink-0 text-success-text" aria-hidden />
                ) : null}
              </li>
            );
          })}
        </ul>

        {canManage ? (
          <div className="flex gap-2 border-t border-border p-3">
            <Input
              value={newItem}
              aria-label="Clearance item"
              placeholder="Add another clearance item"
              className="h-9"
              onChange={(e) => setNewItem(e.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={newItem.trim().length < 2}
              loading={busy === "add"}
              onClick={async () => {
                await act("add", `/api/exit/${exit.id}/checklist`, {
                  action: "add",
                  title: newItem.trim(),
                }, "Added.");
                setNewItem("");
              }}
            >
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
        ) : null}
      </Section>

      {/* ---------- settlement ----------
          Somebody who only runs the process still sees where the money stands
          once there is a figure; what they cannot do is move it. The statement
          is theirs to open too — the service lets `exit.manage` read it. */}
      {canSettle || settlement ? (
        <Section
          title="Full and final settlement"
          description={
            settlement
              ? `${settlement.status.toLowerCase()} · ${formatMoney(settlement.netPaise)}`
              : "Not calculated yet"
          }
        >
          <div className="space-y-3 p-4">
            {exit.noticeShortfallDays > 0 ? (
              <Alert tone="warning" title={`${exit.noticeShortfallDays} days of notice not served`}>
                Recovery for the shortfall is included in the calculation below.
              </Alert>
            ) : null}

            {lines.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border">
                {lines.map((line, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block text-sm">{line.label}</span>
                      {line.formula ? (
                        <span className="block font-mono text-[11px] text-muted-foreground">
                          {line.formula}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={`tabular shrink-0 text-sm ${
                        line.kind === "DEDUCTION" ? "text-danger-text" : ""
                      }`}
                    >
                      {line.kind === "DEDUCTION" ? "−" : ""}
                      {formatMoney(line.amountPaise)}
                    </span>
                  </li>
                ))}
                <li className="flex items-center justify-between gap-3 bg-muted px-3 py-2.5">
                  <span className="text-sm font-medium">Net settlement</span>
                  <span className="tabular text-base font-semibold">
                    {formatMoney(preview?.netPaise ?? settlement?.netPaise ?? 0)}
                  </span>
                </li>
              </ul>
            ) : null}

            {preview?.netInWords ? (
              <p className="text-xs text-muted-foreground">{preview.netInWords}</p>
            ) : null}

            {preview?.warnings.map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
            {preview?.problems.map((p, i) => (
              <Alert key={i} tone="info" title="Check before approving">
                {p}
              </Alert>
            ))}
            {settlement?.note ? <Alert tone="info">{settlement.note}</Alert> : null}
            {error ? <Alert tone="danger">{error}</Alert> : null}

            <div className="flex flex-wrap gap-2">
              {canSettle ? (
                <Button variant="secondary" loading={busy === "preview"} onClick={runPreview}>
                  <Calculator className="size-4" aria-hidden />
                  Preview
                </Button>
              ) : null}

              {canSettle && (!settlement || settlement.status === "CALCULATED") ? (
                <Button
                  loading={busy === "calc"}
                  onClick={() =>
                    act("calc", `/api/exit/${exit.id}/fnf`, { action: "calculate" }, "Calculated.")
                  }
                >
                  <Calculator className="size-4" aria-hidden />
                  {settlement ? "Recalculate" : "Calculate"}
                </Button>
              ) : null}

              {canSettle && settlement?.status === "CALCULATED" ? (
                <Button
                  variant="success"
                  loading={busy === "approve"}
                  onClick={() =>
                    act(
                      "approve",
                      `/api/exit/settlements/${settlement.id}`,
                      { action: "approve" },
                      "Settlement approved and frozen.",
                    )
                  }
                >
                  <CheckCircle2 className="size-4" aria-hidden />
                  Approve
                </Button>
              ) : null}

              {settlement && settlement.status !== "DRAFT" ? (
                <Button variant="ghost" loading={busy === "statement"} onClick={openStatement}>
                  <Download className="size-4" aria-hidden />
                  Statement (PDF)
                </Button>
              ) : null}
            </div>

            {settlement && (settlement.status === "APPROVED" || settlement.status === "PAID") ? (
              <div className="rounded-md border border-border p-3">
                <p className="mb-2 text-sm">
                  Paid {formatMoney(settlement.paidPaise)} of {formatMoney(settlement.netPaise)}
                  {outstanding > 0 ? (
                    <span className="font-medium"> · {formatMoney(outstanding)} outstanding</span>
                  ) : (
                    <Badge tone="success" className="ml-2">
                      settled
                    </Badge>
                  )}
                </p>
                {canSettle && outstanding > 0 ? (
                  <div className="flex gap-2">
                    <Input
                      type="number"
                      min={1}
                      className="tabular h-9"
                      aria-label="Amount in rupees"
                      placeholder="Amount in rupees"
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                    />
                    <Button
                      size="sm"
                      loading={busy === "pay"}
                      disabled={!payAmount || Number(payAmount) <= 0}
                      onClick={async () => {
                        await act(
                          "pay",
                          `/api/exit/settlements/${settlement.id}`,
                          {
                            action: "pay",
                            amountPaise: Math.round(Number(payAmount) * 100),
                            settledOn: new Date().toISOString().slice(0, 10),
                          },
                          "Payment recorded.",
                        );
                        setPayAmount("");
                      }}
                    >
                      <Wallet className="size-4" aria-hidden />
                      Record payment
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </Section>
      ) : exit.status !== "CANCELLED" ? (
        <p className="text-sm text-muted-foreground">
          The settlement is calculated, approved and paid by somebody who can settle exits.
        </p>
      ) : null}

      {/* ---------- closing ----------
          Moving to clearance and calling the exit off belong to whoever runs
          it. Closing is the one that ends the employment and follows a paid
          settlement, so it stays with the settle permission — the service
          asks for the same one. */}
      {(canManage || canSettle) && exit.status !== "SETTLED" && exit.status !== "CANCELLED" ? (
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <Button
              variant="secondary"
              loading={busy === "clearance"}
              disabled={openItems.length > 0}
              title={openItems.length > 0 ? `${openItems.length} clearance item(s) still open` : undefined}
              onClick={() =>
                act("clearance", `/api/exit/${exit.id}`, { action: "status", status: "CLEARANCE" }, "Moved to clearance.")
              }
            >
              Mark clearance done
            </Button>
          ) : null}
          {canSettle ? (
            <Button
              variant="success"
              loading={busy === "settle"}
              disabled={settlement?.status !== "PAID"}
              title={settlement?.status !== "PAID" ? "The settlement must be paid first" : undefined}
              onClick={() =>
                act("settle", `/api/exit/${exit.id}`, { action: "status", status: "SETTLED" }, "Exit closed.")
              }
            >
              <CheckCircle2 className="size-4" aria-hidden />
              Close the exit
            </Button>
          ) : null}
          {canManage ? (
            <Button
              variant="ghost"
              className="text-danger-text"
              loading={busy === "cancel"}
              onClick={() => act("cancel", `/api/exit/${exit.id}`, { action: "cancel" }, "Exit cancelled.")}
            >
              <Ban className="size-4" aria-hidden />
              Cancel this exit
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
