"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadFailed, Spinner } from "@/components/ui/states";
import { WEEKDAY_INITIALS, leadingBlanks } from "@/domain/calendar/monthGrid";
import { shiftMonth, withinWindow } from "@/domain/attendance/monthTotals";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/client/api";

/**
 * One person's month: what was marked on each date, and what it adds up to.
 *
 * **Two buttons, and everything else behind them.** The counts matter on the
 * day somebody disputes a payslip and are noise on every other day, so they do
 * not get a permanent row of tiles — which is also what was asked for.
 *
 * Both read `getMonthlyGrid`, the same function the attendance matrix and the
 * dashboard tiles already use, so the three cannot come to disagree about the
 * same person in the same month. That was the point of not writing a second
 * count here.
 */

interface Day {
  date: string;
  day: number;
  status: string;
  lateMinutes: number;
}

interface Totals {
  present: number;
  absent: number;
  halfDays: number;
  leave: number;
  paidLeave: number;
  unpaidLeave: number;
  weekOff: number;
  holiday: number;
  lateCount: number;
  notMarked: number;
}

interface Payload {
  label: string;
  year: number;
  month: number;
  dates: string[];
  rows: { days: Day[]; totals: Totals }[];
}

/** One letter per status, the same shorthand the attendance matrix uses. */
const LETTER: Record<string, string> = {
  FULL_DAY: "P",
  EXTRA_DAY: "P",
  TRAINING_DAY: "P",
  ON_DUTY: "P",
  HALF_DAY: "½",
  ABSENT: "A",
  PAID_LEAVE: "L",
  UNPAID_LEAVE: "U",
  WEEK_OFF: "W",
  DAY_OFF: "W",
  HOLIDAY: "H",
  NOT_MARKED: "·",
  // Today, still at work. It is the one status on this calendar that is not
  // yet a verdict; a check-out or the nightly close replaces it.
  CHECKED_IN: "I",
};

const TONE: Record<string, string> = {
  FULL_DAY: "bg-success-muted text-success-text",
  EXTRA_DAY: "bg-success-muted text-success-text",
  TRAINING_DAY: "bg-success-muted text-success-text",
  ON_DUTY: "bg-success-muted text-success-text",
  HALF_DAY: "bg-warning-muted text-warning-text",
  ABSENT: "bg-danger-muted text-danger-text",
  PAID_LEAVE: "bg-info-muted text-info-text",
  UNPAID_LEAVE: "bg-warning-muted text-warning-text",
  WEEK_OFF: "bg-muted text-muted-foreground",
  DAY_OFF: "bg-muted text-muted-foreground",
  HOLIDAY: "bg-muted text-muted-foreground",
  NOT_MARKED: "text-muted-foreground",
  CHECKED_IN: "bg-info-muted text-info-text",
};

export function MonthDetail({
  employeeId,
  name,
}: {
  /** Absent for "me", which is how the employee's own screen calls it. */
  employeeId?: string;
  name?: string;
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [open, setOpen] = useState<"calendar" | "report" | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<unknown>(null);

  /**
   * A failure is shown, not swallowed. Offline, or after the session has
   * ended, this used to `.catch(() => setData(null))` and leave the spinner
   * up for as long as the dialog was open, with the arrows re-issuing the same
   * failing request. The dialog now says what happened and offers a retry; a
   * 401 never gets this far, because `api()` sends a dead session to sign in.
   */
  const load = useCallback(
    (y: number, m: number) => {
      setData(null);
      setError(null);
      const query = new URLSearchParams({ year: String(y), month: String(m) });
      if (employeeId) query.set("employeeId", employeeId);
      void api<Payload>(`/api/attendance/month?${query.toString()}`)
        .then(setData)
        .catch((failure: unknown) => setError(failure));
    },
    [employeeId],
  );

  useEffect(() => {
    if (open) load(year, month);
  }, [open, year, month, load]);

  /**
   * The window the arrows may move in.
   *
   * The same three months the reception screen offers, and for the same
   * reason: "was I marked absent in March" is the question, and an unbounded
   * stepper walks somebody into 2019 one tap at a time and loads an empty
   * month each time.
   */
  const nowCursor = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  const cursor = { year, month };
  const canGoBack = withinWindow(shiftMonth(cursor, -1), nowCursor);
  const canGoForward = withinWindow(shiftMonth(cursor, 1), nowCursor);

  function shift(by: number) {
    const next = shiftMonth(cursor, by);
    if (!withinWindow(next, nowCursor)) return;
    setYear(next.year);
    setMonth(next.month);
  }

  const row = data?.rows[0] ?? null;
  const totals = row?.totals ?? null;
  // Week offs and holidays are not days anybody was expected to work.
  const workingDays = data && totals ? data.dates.length - totals.weekOff - totals.holiday : 0;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setOpen("calendar")}>
          <CalendarDays className="size-4" aria-hidden />
          Calendar
        </Button>
        <Button size="sm" variant="outline" onClick={() => setOpen("report")}>
          <ListChecks className="size-4" aria-hidden />
          Month report
        </Button>
      </div>

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {open === "calendar" ? "Calendar" : "Month report"}
              {name ? ` · ${name}` : ""}
            </DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Previous month"
                disabled={!canGoBack}
                onClick={() => shift(-1)}
              >
                <ChevronLeft className="size-4" aria-hidden />
              </Button>
              <p className="text-sm font-medium">{data?.label ?? "…"}</p>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Next month"
                disabled={!canGoForward}
                onClick={() => shift(1)}
              >
                <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>

            {error !== null ? (
              <LoadFailed
                compact
                error={error}
                what="This month"
                onRetry={() => load(year, month)}
              />
            ) : data === null ? (
              <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Spinner /> Loading&hellip;
              </p>
            ) : row === null ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing recorded for this month.
              </p>
            ) : open === "calendar" ? (
              <>
                {/**
                  * Weekday-aligned, which it was not.
                  *
                  * This laid `row.days` straight into a seven-wide grid with no
                  * leading offset, so the first of the month always landed in
                  * the first column. Every column was therefore a different
                  * weekday depending on the month, and "which Sundays were week
                  * offs" — the thing an attendance calendar is read for — could
                  * not be seen at a glance. The header row is the giveaway: it
                  * was not there either, because it could not have been correct.
                  */}
                <div className="grid grid-cols-7 gap-1 text-center">
                  {WEEKDAY_INITIALS.map((initial, i) => (
                    <span
                      key={`${initial}-${i}`}
                      className="pb-0.5 text-[10px] font-medium uppercase text-muted-foreground"
                    >
                      {initial}
                    </span>
                  ))}
                  {Array.from({ length: leadingBlanks(row.days[0]?.date) }, (_, i) => (
                    <span key={`blank-${i}`} aria-hidden />
                  ))}
                  {row.days.map((day) => (
                    <div
                      key={day.date}
                      title={`${day.date} - ${day.status.replaceAll("_", " ").toLowerCase()}`}
                      className={`flex flex-col items-center rounded-md border border-border py-1.5 ${TONE[day.status] ?? ""}`}
                    >
                      <span className="text-[10px] text-muted-foreground">{day.day}</span>
                      <span className="text-sm font-semibold">{LETTER[day.status] ?? "."}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  P present · I checked in · ½ half day · A absent · L paid leave · U unpaid · W
                  week off · H holiday · · not marked
                </p>
              </>
            ) : (
              <dl className="divide-y divide-border rounded-lg border border-border">
                {(
                  [
                    // Both, because they are different questions and the
                    // difference is the whole point of the rows below.
                    ["Days in the month", data.dates.length],
                    ["Total working days", workingDays],
                    ["Present", totals!.present],
                    ["Half days", totals!.halfDays],
                    ["Absent", totals!.absent],
                    ["Paid leave", totals!.paidLeave],
                    ["Unpaid leave", totals!.unpaidLeave],
                    ["Week offs", totals!.weekOff],
                    ["Holidays", totals!.holiday],
                    ["Not marked", totals!.notMarked],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between px-3 py-2">
                    <dt className="text-sm">{label}</dt>
                    <dd className="tabular text-sm font-medium">{value}</dd>
                  </div>
                ))}
                {totals!.lateCount > 0 ? (
                  <div className="flex items-center justify-between px-3 py-2">
                    <dt className="text-sm">Late</dt>
                    <dd>
                      <Badge tone="warning">{totals!.lateCount} days</Badge>
                    </dd>
                  </div>
                ) : null}
              </dl>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
