"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, ScanFace, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { cn, formatDuration } from "@/lib/utils";

/**
 * The month grid.
 *
 * Employees down, days across — because the two questions this screen answers
 * are "who was out on the 14th" (a column) and "what did Sneha do all month" (a
 * row). Each cell is a single letter so a month fits on one screen without
 * scrolling sideways on a laptop; the full status is in the title and in the
 * dialog that opens on click.
 */

export interface GridDay {
  date: string;
  day: number;
  status: string;
  systemStatus: string;
  overridden: boolean;
  lateMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  firstCheckInAt: string | null;
  lastCheckOutAt: string | null;
  id: string | null;
  flagged: boolean;
  /**
   * What the server measured for the first check-in and the last check-out.
   *
   * The accuracy is no longer a gate, so it has to be visible instead: a
   * reviewer deciding whether "12 m from the branch" means anything needs to
   * know the phone said ±40 m when it said it.
   */
  checkIn: { distanceMeters: number | null; accuracyMeters: number | null } | null;
  checkOut: { distanceMeters: number | null; accuracyMeters: number | null } | null;
}

export interface GridRow {
  employeeId: string;
  name: string;
  code: string;
  designation: string | null;
  days: GridDay[];
  totals: {
    present: number;
    absent: number;
    halfDays: number;
    leave: number;
    weekOff: number;
    holiday: number;
    lateCount: number;
    notMarked: number;
  };
}

export interface Grid {
  year: number;
  month: number;
  label: string;
  dates: string[];
  rows: GridRow[];
  flaggedCount: number;
}

/** One letter per status, plus the colour that carries the meaning. */
const CELL: Record<string, { letter: string; className: string; label: string }> = {
  FULL_DAY: { letter: "P", className: "bg-success/20 text-success-text", label: "Full day" },
  EXTRA_DAY: { letter: "E", className: "bg-info/25 text-info-text", label: "Extra day" },
  TRAINING_DAY: { letter: "T", className: "bg-success/15 text-success-text", label: "Training day" },
  ON_DUTY: { letter: "D", className: "bg-info/20 text-info-text", label: "On duty" },
  HALF_DAY: { letter: "½", className: "bg-warning/25 text-warning-text", label: "Half day" },
  ABSENT: { letter: "A", className: "bg-danger/20 text-danger-text", label: "Absent" },
  PAID_LEAVE: { letter: "L", className: "bg-primary/20 text-primary", label: "Paid leave" },
  UNPAID_LEAVE: { letter: "U", className: "bg-warning/20 text-warning-text", label: "Unpaid leave" },
  WEEK_OFF: { letter: "·", className: "bg-muted text-muted-foreground", label: "Week off" },
  DAY_OFF: { letter: "·", className: "bg-muted text-muted-foreground", label: "Day off" },
  HOLIDAY: { letter: "H", className: "bg-muted text-muted-foreground", label: "Holiday" },
  NOT_MARKED: { letter: "", className: "bg-transparent text-muted-foreground", label: "Not marked" },
  // Today, for somebody still at work. It used to show as "½" from the moment
  // they arrived, because a day with no check-out yet was scored as a day
  // whose check-out never came.
  CHECKED_IN: { letter: "I", className: "bg-info/15 text-info-text", label: "Checked in" },
};

/**
 * Deliberately without CHECKED_IN. It is not a verdict an admin can choose:
 * it means "the check-out has not happened yet", and the nightly close turns
 * it into one of these through the missing-check-out rule.
 */
const OVERRIDE_OPTIONS = [
  "FULL_DAY", "HALF_DAY", "ABSENT", "PAID_LEAVE", "UNPAID_LEAVE",
  "EXTRA_DAY", "ON_DUTY", "TRAINING_DAY", "WEEK_OFF", "HOLIDAY", "NOT_MARKED",
];

/**
 * "12 m from the branch, fix ±40 m", or as much of it as was measured.
 *
 * Empty when nothing was: a mark with no coordinates (GPS off for the
 * organisation, or an office device) says nothing rather than "0 m".
 */
function describeMark(
  mark: { distanceMeters: number | null; accuracyMeters: number | null } | null | undefined,
): string {
  if (!mark) return "";
  const parts: string[] = [];
  if (mark.distanceMeters !== null) parts.push(`${mark.distanceMeters} m from the branch`);
  if (mark.accuracyMeters !== null) parts.push(`fix ±${mark.accuracyMeters} m`);
  return parts.join(", ");
}

export function AttendanceGrid({ grid, canOverride }: { grid: Grid; canOverride: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<{ row: GridRow; day: GridDay } | null>(null);
  const [status, setStatus] = useState("FULL_DAY");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  function move(delta: number) {
    const date = new Date(Date.UTC(grid.year, grid.month - 1 + delta, 1));
    router.push(
      `/attendance?year=${date.getUTCFullYear()}&month=${date.getUTCMonth() + 1}`,
    );
  }

  function openCell(row: GridRow, day: GridDay) {
    if (!canOverride) return;
    setOpen({ row, day });
    // Neither is in the list of things a day can be changed to, so the select
    // would otherwise open on a value it cannot show.
    setStatus(day.status === "NOT_MARKED" || day.status === "CHECKED_IN" ? "FULL_DAY" : day.status);
    setReason("");
  }

  async function save() {
    if (!open) return;
    setBusy(true);
    const ok = await mutate(
      () =>
        api("/api/attendance/override", {
          method: "POST",
          body: {
            action: "override",
            employeeId: open.row.employeeId,
            date: open.day.date,
            status,
            reason: reason.trim(),
          },
        }),
      { success: "Attendance updated.", error: "That change was not saved" },
    );
    setBusy(false);
    if (ok !== null) {
      setOpen(null);
      router.refresh();
    }
  }

  async function clearFlag() {
    if (!open) return;
    setBusy(true);
    const ok = await mutate(
      () =>
        api("/api/attendance/override", {
          method: "POST",
          body: { action: "clear-flag", employeeId: open.row.employeeId, date: open.day.date },
        }),
      { success: "Marked as reviewed.", error: "That flag was not cleared" },
    );
    setBusy(false);
    if (ok !== null) {
      setOpen(null);
      router.refresh();
    }
  }

  const markLine = open
    ? [
        describeMark(open.day.checkIn) ? `In: ${describeMark(open.day.checkIn)}` : null,
        describeMark(open.day.checkOut) ? `Out: ${describeMark(open.day.checkOut)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => move(-1)} aria-label="Previous month">
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium">{grid.label}</span>
          <Button size="sm" variant="ghost" onClick={() => move(1)} aria-label="Next month">
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {(["FULL_DAY", "CHECKED_IN", "HALF_DAY", "ABSENT", "PAID_LEAVE", "WEEK_OFF", "HOLIDAY"] as const).map(
            (key) => (
              <span key={key} className="flex items-center gap-1">
                <span
                  className={cn(
                    "grid size-4 place-items-center rounded text-[10px] font-semibold",
                    CELL[key]!.className,
                  )}
                >
                  {CELL[key]!.letter}
                </span>
                {CELL[key]!.label}
              </span>
            ),
          )}
        </div>
      </div>

      {grid.rows.length === 0 ? (
        <EmptyState
          title="Nobody to show"
          description="There are no employees in your scope for this month."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">
                  Employee
                </th>
                {grid.dates.map((date, i) => (
                  <th key={date} className="w-6 px-0 py-2 text-center font-normal text-muted-foreground">
                    {i + 1}
                  </th>
                ))}
                <th className="px-2 py-2 text-right font-medium">P</th>
                <th className="px-2 py-2 text-right font-medium">A</th>
                <th className="px-2 py-2 text-right font-medium">L</th>
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row) => (
                <tr key={row.employeeId} className="border-b border-border last:border-0">
                  <td className="sticky left-0 z-10 max-w-44 bg-card px-3 py-1.5">
                    <span className="block truncate font-medium">{row.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {row.code}
                    </span>
                  </td>

                  {row.days.map((day) => {
                    const cell = CELL[day.status] ?? CELL.NOT_MARKED!;
                    return (
                      <td key={day.date} className="p-0 text-center">
                        <button
                          type="button"
                          disabled={!canOverride}
                          onClick={() => openCell(row, day)}
                          title={`${day.date} · ${cell.label}${
                            day.overridden ? " (changed by hand)" : ""
                          }${day.lateMinutes > 0 ? ` · ${day.lateMinutes} min late` : ""}${
                            day.flagged ? " · face match flagged" : ""
                          }`}
                          className={cn(
                            "relative m-0.5 grid size-5 place-items-center rounded text-[10px] font-semibold",
                            cell.className,
                            canOverride && "hover:ring-1 hover:ring-primary",
                          )}
                        >
                          {cell.letter}
                          {day.overridden ? (
                            <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary" />
                          ) : null}
                          {day.flagged ? (
                            <span className="absolute -bottom-0.5 -left-0.5 size-1.5 rounded-full bg-danger" />
                          ) : null}
                        </button>
                      </td>
                    );
                  })}

                  <td className="px-2 py-1.5 text-right tabular">{row.totals.present}</td>
                  <td className="px-2 py-1.5 text-right tabular text-danger-text">
                    {row.totals.absent || ""}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular">{row.totals.leave || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-primary" /> changed by hand
        </span>
        <span className="flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-danger" /> face match flagged
        </span>
      </p>

      {/* ---------- override dialog ---------- */}
      <Dialog open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {open ? `${open.row.name} · ${open.day.date}` : "Change attendance"}
            </DialogTitle>
          </DialogHeader>

          {open ? (
            <DialogBody className="space-y-3">
              <div className="rounded-md bg-muted px-3 py-2 text-sm">
                <p>
                  Currently <strong>{(CELL[open.day.status] ?? CELL.NOT_MARKED!).label}</strong>
                  {open.day.overridden ? " (changed by hand)" : ""}
                </p>
                {open.day.systemStatus !== open.day.status ? (
                  <p className="text-xs text-muted-foreground">
                    The rules concluded {(CELL[open.day.systemStatus] ?? CELL.NOT_MARKED!).label}.
                  </p>
                ) : null}
                {open.day.workedMinutes > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Worked {formatDuration(open.day.workedMinutes)}
                    {open.day.lateMinutes > 0 ? ` · ${open.day.lateMinutes} min late` : ""}
                    {open.day.overtimeMinutes > 0
                      ? ` · ${formatDuration(open.day.overtimeMinutes)} overtime`
                      : ""}
                  </p>
                ) : null}
                {/* Distance and how rough the reading was, for each end of
                    the day. A distance on its own is what the panel used to
                    print over a Wi-Fi guess; the second number is what tells
                    a reviewer how much to trust the first. */}
                {markLine ? <p className="text-xs text-muted-foreground">{markLine}</p> : null}
              </div>

              {open.day.flagged ? (
                <div className="flex items-start gap-2 rounded-md border border-danger bg-danger-muted px-3 py-2 text-sm">
                  <ScanFace className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">The selfie did not match the reference photo.</p>
                    <p className="text-xs">
                      Check the person before accepting this day, then mark it reviewed.
                    </p>
                    <Button size="sm" variant="ghost" className="mt-1" loading={busy} onClick={clearFlag}>
                      Mark reviewed
                    </Button>
                  </div>
                </div>
              ) : null}

              <Field label="Change it to" htmlFor="overrideStatus" required>
                <Select
                  id="overrideStatus"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  {OVERRIDE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {(CELL[option] ?? CELL.NOT_MARKED!).label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Reason"
                htmlFor="overrideReason"
                required
                hint="Kept with the record. This is what answers a query three months from now."
              >
                <Input
                  id="overrideReason"
                  value={reason}
                  placeholder="Was on client site; punch failed"
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </DialogBody>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={reason.trim().length < 3} onClick={save}>
              Save change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {grid.flaggedCount > 0 ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-danger-text">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {grid.flaggedCount} check-in(s) this month had a face match that did not pass.
        </p>
      ) : null}
    </>
  );
}
