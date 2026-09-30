"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Paperclip, Plus, Receipt, Send, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert, EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { formatDate, formatMoney, pluralise } from "@/lib/utils";

/**
 * Expense claims, from both sides.
 *
 * A claim is a draft while receipts are being added and only reaches an
 * approver on submit. The approver's amount box is pre-filled with the claimed
 * total but editable, because "the taxi yes, the dinner no" is the normal
 * outcome and rejecting the whole claim to re-enter it is not.
 */

export interface ClaimItem {
  id: string;
  category: string;
  categoryLabel: string;
  description: string | null;
  spentOn: string;
  amountPaise: number;
  fileUrl: string | null;
  fileName: string | null;
}

export interface Claim {
  id: string;
  claimNumber: string;
  title: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "PAID" | "CANCELLED";
  totalPaise: number;
  approvedPaise: number;
  reviewNote: string | null;
  paidWithPayroll: boolean;
  employee: { id: string; name: string; code: string };
  items: ClaimItem[];
  isMine: boolean;
}

const TONE = {
  DRAFT: "neutral",
  SUBMITTED: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  PAID: "success",
  CANCELLED: "neutral",
} as const;

const CATEGORIES = [
  "TRAVEL", "ACCOMMODATION", "MEALS", "FUEL", "TELECOM", "INTERNET",
  "TRAINING", "MEDICAL", "OFFICE_SUPPLIES", "CLIENT_ENTERTAINMENT", "OTHER",
];

const LABEL: Record<string, string> = {
  TRAVEL: "Travel", ACCOMMODATION: "Accommodation", MEALS: "Meals", FUEL: "Fuel",
  TELECOM: "Phone", INTERNET: "Internet", TRAINING: "Training", MEDICAL: "Medical",
  OFFICE_SUPPLIES: "Office supplies", CLIENT_ENTERTAINMENT: "Client entertainment", OTHER: "Other",
};

export function Claims({
  claims,
  canApprove,
  canClaim,
}: {
  claims: Claim[];
  canApprove: boolean;
  canClaim: boolean;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [approveAmount, setApproveAmount] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [item, setItem] = useState({
    category: "TRAVEL",
    description: "",
    spentOn: new Date().toISOString().slice(0, 10),
    rupees: "",
  });

  async function act(key: string, id: string, body: unknown, success: string) {
    setBusy(key);
    const ok = await mutate(
      () => api(`/api/reimbursements/${id}`, { method: "POST", body }),
      { success, error: "That did not work" },
    );
    setBusy(null);
    if (ok !== null) {
      setRejecting(null);
      setDiscarding(null);
      setNote("");
      router.refresh();
    }
  }

  async function startClaim() {
    setBusy("new");
    const created = await mutate(
      () =>
        api<{ id: string; claimNumber: string }>("/api/reimbursements", {
          method: "POST",
          body: { title: newTitle.trim() || "Expense claim" },
        }),
      { success: "Claim started — add your receipts.", error: "That claim was not started" },
    );
    setBusy(null);
    if (created) {
      setNewTitle("");
      setExpanded(created.id);
      router.refresh();
    }
  }

  async function addExpense(claimId: string) {
    const rupees = Number(item.rupees);
    if (!Number.isFinite(rupees) || rupees <= 0) return;

    setBusy(`item-${claimId}`);
    const form = new FormData();
    form.set("category", item.category);
    form.set("description", item.description);
    form.set("spentOn", item.spentOn);
    form.set("amountPaise", String(Math.round(rupees * 100)));
    const file = fileInput.current?.files?.[0];
    if (file) form.set("bill", file);

    try {
      const res = await fetch(`/api/reimbursements/${claimId}`, { method: "PUT", body: form });
      if (!res.ok) {
        const payload = await res.json();
        throw new Error(payload?.error?.message ?? "That expense was not added.");
      }
      setItem((i) => ({ ...i, description: "", rupees: "" }));
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "That expense was not added.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {canClaim ? (
        <div className="flex flex-wrap gap-2 rounded-lg border border-border bg-card p-3">
          <Input
            value={newTitle}
            aria-label="What the claim is for"
                placeholder="What is this claim for? e.g. Client visit, Bengaluru"
            className="min-w-48 flex-1"
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <Button loading={busy === "new"} onClick={startClaim}>
            <Plus className="size-4" aria-hidden />
            Start a claim
          </Button>
        </div>
      ) : null}

      {claims.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No claims yet"
          description={
            canClaim
              ? "Start a claim, attach your receipts, then send it for approval."
              : "Claims from your team will appear here once they are submitted."
          }
        />
      ) : (
        <ul className="space-y-3">
          {claims.map((claim) => {
            const open = expanded === claim.id;
            const editable = claim.isMine && claim.status === "DRAFT";

            return (
              <li key={claim.id} className="rounded-lg border border-border bg-card">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : claim.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {claim.title}
                      <Badge tone={TONE[claim.status]}>{claim.status.toLowerCase()}</Badge>
                      {claim.paidWithPayroll ? <Badge tone="info">with payroll</Badge> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {claim.claimNumber} · {claim.items.length} item(s)
                      {!claim.isMine ? ` · ${claim.employee.name} (${claim.employee.code})` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="tabular text-sm font-semibold">{formatMoney(claim.totalPaise)}</p>
                    {claim.status === "APPROVED" || claim.status === "PAID" ? (
                      <p className="tabular text-xs text-success-text">
                        {formatMoney(claim.approvedPaise)} approved
                      </p>
                    ) : null}
                  </div>
                </button>

                {open ? (
                  <div className="border-t border-border p-3">
                    <ul className="mb-3 divide-y divide-border rounded-md border border-border">
                      {claim.items.map((i) => (
                        <li key={i.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                          <span className="min-w-0 flex-1">
                            <span className="block">
                              {i.categoryLabel}
                              {i.description ? ` — ${i.description}` : ""}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {formatDate(i.spentOn)}
                            </span>
                          </span>
                          {i.fileUrl ? (
                            <a
                              href={i.fileUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              title={i.fileName ?? "Bill"}
                              className="shrink-0 text-muted-foreground hover:text-foreground"
                            >
                              <Paperclip className="size-4" />
                            </a>
                          ) : null}
                          <span className="tabular shrink-0">{formatMoney(i.amountPaise)}</span>
                          {editable ? (
                            <button
                              type="button"
                              aria-label="Remove"
                              className="shrink-0 text-muted-foreground hover:text-danger-text"
                              onClick={() =>
                                act(`rm-${i.id}`, claim.id, { action: "remove-item", itemId: i.id }, "Removed.")
                              }
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          ) : null}
                        </li>
                      ))}
                      {claim.items.length === 0 ? (
                        <li className="px-3 py-3 text-sm text-muted-foreground">
                          No expenses added yet.
                        </li>
                      ) : null}
                    </ul>

                    {claim.reviewNote ? (
                      <div className="mb-3">
                        <Alert tone={claim.status === "REJECTED" ? "danger" : "info"}>
                          {claim.reviewNote}
                        </Alert>
                      </div>
                    ) : null}

                    {editable ? (
                      <div className="space-y-2 rounded-md border border-border p-3">
                        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-4">
                          <Field label="Category" htmlFor={`cat-${claim.id}`}>
                            <Select
                              id={`cat-${claim.id}`}
                              value={item.category}
                              onChange={(e) => setItem((i) => ({ ...i, category: e.target.value }))}
                            >
                              {CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {LABEL[c]}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Spent on" htmlFor={`date-${claim.id}`}>
                            <Input
                              id={`date-${claim.id}`}
                              type="date"
                              max={new Date().toISOString().slice(0, 10)}
                              value={item.spentOn}
                              onChange={(e) => setItem((i) => ({ ...i, spentOn: e.target.value }))}
                            />
                          </Field>
                          <Field label="Amount (₹)" htmlFor={`amt-${claim.id}`}>
                            <Input
                              id={`amt-${claim.id}`}
                              type="number"
                              min={1}
                              className="tabular"
                              value={item.rupees}
                              onChange={(e) => setItem((i) => ({ ...i, rupees: e.target.value }))}
                            />
                          </Field>
                          <Field label="Bill" htmlFor={`bill-${claim.id}`} hint="Image or PDF">
                            <Input id={`bill-${claim.id}`} ref={fileInput} type="file" accept="image/*,application/pdf" />
                          </Field>
                        </div>
                        <Input
                          value={item.description}
                          placeholder="What was it for?"
                          onChange={(e) => setItem((i) => ({ ...i, description: e.target.value }))}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={busy === `item-${claim.id}`}
                            disabled={!item.rupees}
                            onClick={() => addExpense(claim.id)}
                          >
                            <Plus className="size-4" aria-hidden />
                            Add expense
                          </Button>
                          <Button
                            size="sm"
                            disabled={claim.items.length === 0}
                            loading={busy === `submit-${claim.id}`}
                            onClick={() =>
                              act(`submit-${claim.id}`, claim.id, { action: "submit" }, "Sent for approval.")
                            }
                          >
                            <Send className="size-4" aria-hidden />
                            Send for approval
                          </Button>

                          {/**
                            * The way out of a draft.
                            *
                            * "Start a claim" makes the row at once, so a change
                            * of mind or a double press used to leave an empty
                            * draft in this list for good. One press to ask,
                            * one to confirm -- a receipt already attached goes
                            * with it, and the question says so.
                            */}
                          {discarding === claim.id ? (
                            <>
                              <span className="self-center text-xs text-muted-foreground">
                                {claim.items.length > 0
                                  ? `Throw away this draft and its ${pluralise(claim.items.length, "expense")}?`
                                  : "Throw away this draft?"}
                              </span>
                              <Button
                                size="sm"
                                variant="danger"
                                loading={busy === `discard-${claim.id}`}
                                onClick={() =>
                                  act(`discard-${claim.id}`, claim.id, { action: "discard" }, "Draft discarded.")
                                }
                              >
                                Discard
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setDiscarding(null)}>
                                Keep it
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="ml-auto text-danger-text"
                              onClick={() => setDiscarding(claim.id)}
                            >
                              <Trash2 className="size-4" aria-hidden />
                              Discard
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : null}

                    {canApprove && claim.status === "SUBMITTED" && !claim.isMine ? (
                      rejecting === claim.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            autoFocus
                            value={note}
                            placeholder="Why not?"
                            className="h-9 w-56"
                            onChange={(e) => setNote(e.target.value)}
                          />
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={!note.trim()}
                            loading={busy === `reject-${claim.id}`}
                            onClick={() =>
                              act(`reject-${claim.id}`, claim.id, { action: "reject", note: note.trim() }, "Rejected.")
                            }
                          >
                            Confirm
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { setRejecting(null); setNote(""); }}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-end gap-2">
                          <Field
                            label="Approve how much? (₹)"
                            htmlFor={`app-${claim.id}`}
                            hint="Less than claimed is fine — say why below."
                          >
                            <Input
                              id={`app-${claim.id}`}
                              type="number"
                              min={1}
                              max={claim.totalPaise / 100}
                              className="tabular w-36"
                              value={approveAmount[claim.id] ?? String(claim.totalPaise / 100)}
                              onChange={(e) =>
                                setApproveAmount((a) => ({ ...a, [claim.id]: e.target.value }))
                              }
                            />
                          </Field>
                          <Input
                            value={note}
                            placeholder="Note (required if you reduce it)"
                            className="h-9 min-w-48 flex-1"
                            onChange={(e) => setNote(e.target.value)}
                          />
                          <Button
                            size="sm"
                            variant="success"
                            loading={busy === `approve-${claim.id}`}
                            onClick={() =>
                              act(
                                `approve-${claim.id}`,
                                claim.id,
                                {
                                  action: "approve",
                                  approvedPaise: Math.round(
                                    Number(approveAmount[claim.id] ?? claim.totalPaise / 100) * 100,
                                  ),
                                  ...(note.trim() ? { note: note.trim() } : {}),
                                },
                                "Approved.",
                              )
                            }
                          >
                            <Check className="size-4" aria-hidden />
                            Approve
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setRejecting(claim.id)}>
                            <X className="size-4" aria-hidden />
                            Reject
                          </Button>
                        </div>
                      )
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
