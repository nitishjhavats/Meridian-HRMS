"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequestFailed, api, mutate } from "@/lib/client/api";

/**
 * Asking for leave.
 *
 * The day count is computed by the server as the dates change, not in the
 * browser: week-offs and holidays are organisation data, and a total worked out
 * client-side would disagree with the one that actually gets booked.
 */

interface LeaveTypeOption {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  allowHalfDay: boolean;
  noticeDays: number;
}

interface Preview {
  type: { isWeekOff: boolean };
  counted: {
    totalDays: number;
    skipped: { date: string; reason: "WEEK_OFF" | "HOLIDAY" }[];
  };
  available: number;
  /** The type's monthly cap, for the month the request starts in; null when it has none. */
  monthly: { cap: number; month: string; label: string; taken: number; left: number } | null;
  problems: { code: string; message: string }[];
  ok: boolean;
}

const DAY_PARTS = [
  { value: "FULL", label: "Full day" },
  { value: "FIRST_HALF", label: "First half" },
  { value: "SECOND_HALF", label: "Second half" },
] as const;

export function RequestLeave({ types }: { types: LeaveTypeOption[] }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);

  const [form, setForm] = useState({
    leaveTypeId: types[0]?.id ?? "",
    startDate: today,
    endDate: today,
    startDayPart: "FULL",
    endDayPart: "FULL",
    reason: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = types.find((t) => t.id === form.leaveTypeId);
  const singleDay = form.startDate === form.endDate;

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // Re-price whenever anything that affects the total changes.
  useEffect(() => {
    if (!form.leaveTypeId || !form.startDate || !form.endDate) return;
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const result = await api<{ preview: Preview }>("/api/leave/preview", {
          method: "POST",
          body: {
            leaveTypeId: form.leaveTypeId,
            startDate: form.startDate,
            endDate: form.endDate,
            startDayPart: form.startDayPart,
            // A one-day request has only one day part; sending a second would
            // halve it twice.
            endDayPart: singleDay ? form.startDayPart : form.endDayPart,
          },
        });
        if (!cancelled) {
          setPreview(result.preview);
          setPreviewError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(
            err instanceof RequestFailed ? err.error.message : "Could not work out the days.",
          );
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.leaveTypeId, form.startDate, form.endDate, form.startDayPart, form.endDayPart, singleDay]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ id: string; totalDays: number }>("/api/leave", {
          method: "POST",
          body: {
            leaveTypeId: form.leaveTypeId,
            startDate: form.startDate,
            endDate: form.endDate,
            startDayPart: form.startDayPart,
            endDayPart: singleDay ? form.startDayPart : form.endDayPart,
            ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
          },
        }),
      { success: "Leave requested.", error: "That request was not submitted" },
    );
    setBusy(false);
    if (result) {
      setForm((f) => ({ ...f, reason: "" }));
      setPreview(null);
      router.refresh();
    }
  }

  if (types.length === 0) {
    return (
      <Alert tone="info" title="No leave types are set up">
        Ask an administrator to add leave types before requesting leave.
      </Alert>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarPlus className="size-4 text-primary" aria-hidden />
          Request leave
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Leave type" htmlFor="leaveTypeId" required>
            <Select
              id="leaveTypeId"
              value={form.leaveTypeId}
              onChange={(e) => set("leaveTypeId", e.target.value)}
            >
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.code}){t.paid ? "" : " — unpaid"}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="From" htmlFor="startDate" required>
              <Input
                id="startDate"
                type="date"
                value={form.startDate}
                onChange={(e) => {
                  const value = e.target.value;
                  setForm((f) => ({
                    ...f,
                    startDate: value,
                    // Keep the range coherent rather than silently invalid.
                    endDate: f.endDate < value ? value : f.endDate,
                  }));
                }}
                required
              />
            </Field>
            <Field label="To" htmlFor="endDate" required>
              <Input
                id="endDate"
                type="date"
                min={form.startDate}
                value={form.endDate}
                onChange={(e) => set("endDate", e.target.value)}
                required
              />
            </Field>
          </div>

          {selected?.allowHalfDay ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label={singleDay ? "Part of day" : "First day"} htmlFor="startDayPart">
                <Select
                  id="startDayPart"
                  value={form.startDayPart}
                  onChange={(e) => set("startDayPart", e.target.value)}
                >
                  {DAY_PARTS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {!singleDay ? (
                <Field label="Last day" htmlFor="endDayPart">
                  <Select
                    id="endDayPart"
                    value={form.endDayPart}
                    onChange={(e) => set("endDayPart", e.target.value)}
                  >
                    {DAY_PARTS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
            </div>
          ) : null}

          <Field label="Reason" htmlFor="reason" hint="Optional, but it helps your manager decide.">
            <Textarea
              id="reason"
              rows={2}
              value={form.reason}
              onChange={(e) => set("reason", e.target.value)}
            />
          </Field>

          {preview ? (
            <div className="rounded-md bg-muted px-3 py-2 text-sm">
              <div className="flex items-baseline justify-between">
                <span className="text-muted-foreground">This request</span>
                <span className="tabular font-medium">
                  {preview.counted.totalDays} day{preview.counted.totalDays === 1 ? "" : "s"}
                </span>
              </div>
              {preview.counted.skipped.length > 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {preview.counted.skipped.length} day(s) not counted — week-offs and holidays.
                </p>
              ) : null}
              <p className="mt-0.5 text-xs text-muted-foreground">
                {preview.available} day(s) available after pending requests.
              </p>
              {preview.type.isWeekOff ? (
                // The one line that stops the two questions this type raises:
                // a Sunday is not charged to it, and the four a month are a
                // cap on the month, not a pool to be spent in a week.
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Your usual rest days are never charged to this.
                  {preview.monthly
                    ? ` At most ${preview.monthly.cap} a month: ${preview.monthly.left} left in ${preview.monthly.label}.`
                    : ""}
                </p>
              ) : null}
            </div>
          ) : null}

          {preview && preview.problems.length > 0 ? (
            <Alert tone="danger" title="This request cannot be submitted">
              <ul className="list-inside list-disc">
                {preview.problems.map((p) => (
                  <li key={p.code}>{p.message}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {previewError ? <Alert tone="warning">{previewError}</Alert> : null}

          <Button type="submit" loading={busy} disabled={!preview?.ok}>
            <Send className="size-4" aria-hidden />
            Send for approval
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
