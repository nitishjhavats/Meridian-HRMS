"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Laptop, Plus, Undo2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import { formatDate, formatMoney } from "@/lib/utils";

/**
 * The asset register.
 *
 * Issue and return are the only two things that happen here, so both are inline
 * rather than behind a dialog — an HR person handing out five laptops on a
 * Monday should not open five modals.
 */

export interface Asset {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  categoryLabel: string;
  serialNumber: string | null;
  status: "AVAILABLE" | "ASSIGNED" | "IN_REPAIR" | "RETIRED" | "LOST";
  valuePaise: number | null;
  heldBy: {
    assignmentId: string;
    employeeId: string;
    name: string;
    code: string;
    issuedOn: string;
    dueOn: string | null;
    overdue: boolean;
    acknowledged: boolean;
  } | null;
}

const TONE = {
  AVAILABLE: "success",
  ASSIGNED: "info",
  IN_REPAIR: "warning",
  RETIRED: "neutral",
  LOST: "danger",
} as const;

const CATEGORIES = [
  "LAPTOP", "DESKTOP", "MONITOR", "PHONE", "SIM",
  "ACCESS_CARD", "FURNITURE", "VEHICLE", "TOOL", "OTHER",
];

const LABEL: Record<string, string> = {
  LAPTOP: "Laptop", DESKTOP: "Desktop", MONITOR: "Monitor", PHONE: "Phone", SIM: "SIM card",
  ACCESS_CARD: "Access card", FURNITURE: "Furniture", VEHICLE: "Vehicle", TOOL: "Tool", OTHER: "Other",
};

export function AssetRegister({
  assets,
  employees,
}: {
  assets: Asset[];
  employees: { id: string; name: string; code: string }[];
}) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [issuing, setIssuing] = useState<string | null>(null);
  const [returning, setReturning] = useState<string | null>(null);

  const [form, setForm] = useState({
    assetTag: "", name: "", category: "LAPTOP", serialNumber: "", valueRupees: "",
  });
  const [issue, setIssue] = useState({ employeeId: employees[0]?.id ?? "", condition: "" });
  const [ret, setRet] = useState({ condition: "", recoveryRupees: "" });

  async function post(key: string, path: string, body: unknown, success: string) {
    setBusy(key);
    const ok = await mutate(() => api(path, { method: "POST", body }), { success, error: "That did not work" });
    setBusy(null);
    if (ok !== null) {
      setAdding(false);
      setIssuing(null);
      setReturning(null);
      router.refresh();
    }
  }

  const actions = (a: Asset) => {
    if (issuing === a.id) {
      return (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Issue to" htmlFor={`to-${a.id}`}>
            <Select
              id={`to-${a.id}`}
              value={issue.employeeId}
              onChange={(e) => setIssue((i) => ({ ...i, employeeId: e.target.value }))}
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.code})
                </option>
              ))}
            </Select>
          </Field>
          <Input
            value={issue.condition}
            aria-label="Condition"
                placeholder="Condition, e.g. new in box"
            className="h-9 w-44"
            onChange={(e) => setIssue((i) => ({ ...i, condition: e.target.value }))}
          />
          <Button
            size="sm"
            loading={busy === a.id}
            disabled={!issue.employeeId}
            onClick={() =>
              post(a.id, "/api/assets", {
                action: "issue",
                assetId: a.id,
                employeeId: issue.employeeId,
                issuedOn: today,
                ...(issue.condition.trim() ? { conditionOnIssue: issue.condition.trim() } : {}),
              }, "Issued.")
            }
          >
            Confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setIssuing(null)}>
            Cancel
          </Button>
        </div>
      );
    }

    if (returning === a.id && a.heldBy) {
      return (
        <div className="flex flex-wrap items-end gap-2">
          <Input
            value={ret.condition}
            placeholder="Condition on return"
            className="h-9 w-44"
            onChange={(e) => setRet((r) => ({ ...r, condition: e.target.value }))}
          />
          <Field label="Recover (₹)" htmlFor={`rec-${a.id}`} hint="Leave blank if undamaged.">
            <Input
              id={`rec-${a.id}`}
              type="number"
              min={0}
              className="tabular h-9 w-28"
              value={ret.recoveryRupees}
              onChange={(e) => setRet((r) => ({ ...r, recoveryRupees: e.target.value }))}
            />
          </Field>
          <Button
            size="sm"
            loading={busy === a.id}
            onClick={() =>
              post(a.id, `/api/assets/${a.id}`, {
                action: "return",
                assignmentId: a.heldBy!.assignmentId,
                returnedOn: today,
                ...(ret.condition.trim() ? { conditionOnReturn: ret.condition.trim() } : {}),
                ...(ret.recoveryRupees
                  ? { recoveryPaise: Math.round(Number(ret.recoveryRupees) * 100) }
                  : {}),
              }, "Returned.")
            }
          >
            Confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setReturning(null)}>
            Cancel
          </Button>
        </div>
      );
    }

    if (a.heldBy) {
      return (
        <Button size="sm" variant="secondary" onClick={() => setReturning(a.id)}>
          <Undo2 className="size-4" aria-hidden />
          Return
        </Button>
      );
    }

    if (a.status === "AVAILABLE") {
      /**
       * A brand-new organisation has assets before it has people.
       *
       * The select was empty, Confirm posted `employeeId: ""` and the toast
       * said the employee could not be found -- true, and no help at all. The
       * button stays visible so the register still reads as one that issues
       * things; the line beside it says what has to happen first.
       */
      if (employees.length === 0) {
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled>
              <UserPlus className="size-4" aria-hidden />
              Issue
            </Button>
            <span className="text-xs text-muted-foreground">
              <Link href="/employees" className="underline underline-offset-2">
                Add an employee
              </Link>{" "}
              first.
            </span>
          </div>
        );
      }
      return (
        <Button
          size="sm"
          onClick={() => {
            // The roster can change under a mounted screen -- somebody added
            // in another tab arrives on refresh -- and a select whose value
            // matches no option shows its first entry while posting the old
            // one. Settle on a real person the moment the panel opens.
            if (!employees.some((e) => e.id === issue.employeeId)) {
              setIssue((i) => ({ ...i, employeeId: employees[0]!.id }));
            }
            setIssuing(a.id);
          }}
        >
          <UserPlus className="size-4" aria-hidden />
          Issue
        </Button>
      );
    }

    return null;
  };

  return (
    <div className="space-y-3">
      {adding ? (
        <div className="space-y-3 rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-5">
            <Field label="Tag" htmlFor="tag" required hint="e.g. LAP-014">
              <Input
                id="tag"
                value={form.assetTag}
                onChange={(e) => setForm((f) => ({ ...f, assetTag: e.target.value }))}
              />
            </Field>
            <Field label="What is it" htmlFor="name" required>
              <Input
                id="name"
                value={form.name}
                placeholder="ThinkPad T14"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </Field>
            <Field label="Category" htmlFor="cat">
              <Select
                id="cat"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Serial" htmlFor="serial">
              <Input
                id="serial"
                value={form.serialNumber}
                onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value }))}
              />
            </Field>
            <Field label="Value (₹)" htmlFor="value">
              <Input
                id="value"
                type="number"
                min={0}
                className="tabular"
                value={form.valueRupees}
                onChange={(e) => setForm((f) => ({ ...f, valueRupees: e.target.value }))}
              />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button
              loading={busy === "create"}
              disabled={form.assetTag.trim().length < 2 || form.name.trim().length < 2}
              onClick={() =>
                post("create", "/api/assets", {
                  action: "create",
                  assetTag: form.assetTag.trim(),
                  name: form.name.trim(),
                  category: form.category,
                  ...(form.serialNumber.trim() ? { serialNumber: form.serialNumber.trim() } : {}),
                  ...(form.valueRupees ? { valuePaise: Math.round(Number(form.valueRupees) * 100) } : {}),
                }, "Added to the register.")
              }
            >
              Add
            </Button>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setAdding(true)}>
          <Plus className="size-4" aria-hidden />
          Add an asset
        </Button>
      )}

      <ResponsiveList
        items={assets}
        empty={
          <EmptyState
            icon={Laptop}
            title="Nothing in the register"
            description="Add laptops, phones and access cards so an exit can tell you what is still out."
          />
        }
        head={
          <>
            <TH>Tag</TH>
            <TH>Asset</TH>
            <TH>Held by</TH>
            <TH>Value</TH>
            <TH>Status</TH>
            <TH />
          </>
        }
        row={(a) => (
          <TR key={a.id}>
            <TD className="tabular font-medium">{a.assetTag}</TD>
            <TD>
              {a.name}
              <span className="block text-xs text-muted-foreground">
                {a.categoryLabel}
                {a.serialNumber ? ` · ${a.serialNumber}` : ""}
              </span>
            </TD>
            <TD>
              {a.heldBy ? (
                <>
                  <span className="flex items-center gap-1">
                    {a.heldBy.name}
                    {a.heldBy.acknowledged ? (
                      <Check className="size-3.5 text-success-text" role="img" aria-label="Acknowledged" />
                    ) : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    since {formatDate(a.heldBy.issuedOn)}
                    {a.heldBy.overdue ? " · overdue" : ""}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TD>
            <TD className="tabular">
              {a.valuePaise != null ? formatMoney(a.valuePaise) : "—"}
            </TD>
            <TD>
              <Badge tone={TONE[a.status]}>{a.status.replaceAll("_", " ").toLowerCase()}</Badge>
            </TD>
            <TD>{actions(a)}</TD>
          </TR>
        )}
        card={(a) => (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {a.assetTag} · {a.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {a.categoryLabel}
                  {a.heldBy ? ` · with ${a.heldBy.name}` : ""}
                </p>
              </div>
              <Badge tone={TONE[a.status]}>{a.status.replaceAll("_", " ").toLowerCase()}</Badge>
            </div>
            {actions(a)}
          </div>
        )}
      />
    </div>
  );
}
