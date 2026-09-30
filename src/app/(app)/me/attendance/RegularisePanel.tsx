"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { api, mutate } from "@/lib/client/api";
import { formatDate } from "@/lib/utils";

/**
 * Asking for a day to be corrected.
 *
 * Without this a missed punch has no employee-side remedy — you have to find
 * somebody with override rights and persuade them in person. Here the person
 * explains once, in writing, and it goes to whoever decides.
 */

export interface MyRegularisation {
  id: string;
  date: string;
  requestedStatus: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reviewNote: string | null;
  currentStatus: string | null;
}

const TONE = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
} as const;

const OPTIONS = [
  { value: "FULL_DAY", label: "Full day" },
  { value: "HALF_DAY", label: "Half day" },
  { value: "ON_DUTY", label: "On duty (client site / field)" },
  { value: "PAID_LEAVE", label: "Paid leave" },
  { value: "UNPAID_LEAVE", label: "Unpaid leave" },
  { value: "EXTRA_DAY", label: "Extra day worked" },
];

export function RegularisePanel({ requests }: { requests: MyRegularisation[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  const [form, setForm] = useState({
    date: today,
    requestedStatus: "FULL_DAY",
    checkIn: "",
    checkOut: "",
    reason: "",
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy("new");
    const ok = await mutate(
      () =>
        api("/api/attendance/regularisations", {
          method: "POST",
          body: {
            date: form.date,
            requestedStatus: form.requestedStatus,
            ...(form.checkIn ? { checkIn: form.checkIn } : {}),
            ...(form.checkOut ? { checkOut: form.checkOut } : {}),
            reason: form.reason.trim(),
          },
        }),
      { success: "Sent for approval.", error: "That request was not sent" },
    );
    setBusy(null);
    if (ok !== null) {
      setForm((f) => ({ ...f, reason: "", checkIn: "", checkOut: "" }));
      setOpen(false);
      router.refresh();
    }
  }

  async function cancel(id: string) {
    setBusy(id);
    const ok = await mutate(
      () => api(`/api/attendance/regularisations/${id}`, { method: "POST", body: { action: "cancel" } }),
      { success: "Request withdrawn.", error: "That request was not withdrawn" },
    );
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  return (
    <div className="space-y-3 p-4">
      {!open ? (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          <ClipboardCheck className="size-4" aria-hidden />
          Ask for a correction
        </Button>
      ) : (
        <form onSubmit={submit} className="space-y-3 rounded-md border border-border p-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Which day" htmlFor="regDate" required>
              <Input
                id="regDate"
                type="date"
                max={today}
                value={form.date}
                onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                required
              />
            </Field>
            <Field label="Should be" htmlFor="regStatus" required>
              <Select
                id="regStatus"
                value={form.requestedStatus}
                onChange={(e) => setForm((f) => ({ ...f, requestedStatus: e.target.value }))}
              >
                {OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="In at" htmlFor="regIn" hint="Optional">
              <Input
                id="regIn"
                type="time"
                value={form.checkIn}
                onChange={(e) => setForm((f) => ({ ...f, checkIn: e.target.value }))}
              />
            </Field>
            <Field label="Out at" htmlFor="regOut" hint="Optional">
              <Input
                id="regOut"
                type="time"
                value={form.checkOut}
                onChange={(e) => setForm((f) => ({ ...f, checkOut: e.target.value }))}
              />
            </Field>
          </div>

          <Field
            label="What happened"
            htmlFor="regReason"
            required
            hint="Your manager decides on this, so be specific."
          >
            <Textarea
              id="regReason"
              rows={2}
              value={form.reason}
              placeholder="Was at the client site all day; the app would not open at the gate."
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              required
            />
          </Field>

          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={busy === "new"} disabled={form.reason.trim().length < 5}>
              <Send className="size-4" aria-hidden />
              Send
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {requests.length > 0 ? (
        <ul className="space-y-1.5">
          {requests.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {formatDate(r.date)} →{" "}
                  {r.requestedStatus.replaceAll("_", " ").toLowerCase()}
                </p>
                <p className="text-xs text-muted-foreground">{r.reason}</p>
                {r.reviewNote ? (
                  <p className="text-xs text-muted-foreground">“{r.reviewNote}”</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
                {r.status === "PENDING" ? (
                  <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => cancel(r.id)}>
                    <X className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
