"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, ListChecks, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/states";
import { WEEKDAY_INITIALS, leadingBlanks } from "@/domain/calendar/monthGrid";
import { api } from "@/lib/client/api";
import type { KioskMonth as KioskMonthPayload } from "@/services/attendance/kiosk";

/**
 * One person's month, at the reception screen.
 *
 * Two questions, one panel: which days were what, and how many of each. They
 * are the same data and splitting them across two screens would mean two loads
 * and two places to be wrong; the toggle at the top swaps the view.
 *
 * Sized for somebody standing at arm's length with a bag in one hand, like the
 * rest of this screen — big tiles, big arrows, one tap to close.
 */

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
  // Today, still at work. Without it the tile read "·" (or "½" before the
  // domain stopped scoring an open day) for the whole shift.
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
  CHECKED_IN: "bg-info-muted text-info-text",
};

export function KioskMonth({
  employeeId,
  name,
  view,
  onClose,
}: {
  employeeId: string;
  name: string;
  /** Which of the two buttons was pressed. Switchable once open. */
  view: "calendar" | "summary";
  onClose: () => void;
}) {
  const now = new Date();
  const [cursor, setCursor] = useState({
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
  });
  const [mode, setMode] = useState(view);
  const [data, setData] = useState<KioskMonthPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (year: number, month: number) => {
      setData(null);
      setError(null);
      const query = new URLSearchParams({
        employeeId,
        year: String(year),
        month: String(month),
      });
      void api<KioskMonthPayload>(`/api/kiosk/month?${query.toString()}`)
        .then(setData)
        .catch(() => setError("That could not be loaded."));
    },
    [employeeId],
  );

  useEffect(() => {
    load(cursor.year, cursor.month);
  }, [load, cursor]);

  function shift(by: number) {
    setCursor((c) => {
      const index = c.year * 12 + (c.month - 1) + by;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    });
  }

  const totals = data?.totals;

  return (
    <div className="mx-auto w-full max-w-lg space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-2xl font-semibold">{name}</p>
          <p className="text-sm text-muted-foreground">{data?.label ?? "…"}</p>
        </div>
        <Button variant="ghost" size="lg" aria-label="Close" onClick={onClose}>
          <X className="size-6" aria-hidden />
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          size="lg"
          variant="secondary"
          aria-label="Previous month"
          disabled={!data?.canGoBack}
          onClick={() => shift(-1)}
        >
          <ChevronLeft className="size-5" aria-hidden />
        </Button>

        {/* The two views, as one control. Both are the same month already
            loaded, so switching costs nothing. */}
        <div className="flex gap-2">
          <Button
            size="lg"
            variant={mode === "calendar" ? "primary" : "ghost"}
            onClick={() => setMode("calendar")}
          >
            <CalendarDays className="size-5" aria-hidden />
            Calendar
          </Button>
          <Button
            size="lg"
            variant={mode === "summary" ? "primary" : "ghost"}
            onClick={() => setMode("summary")}
          >
            <ListChecks className="size-5" aria-hidden />
            Totals
          </Button>
        </div>

        <Button
          size="lg"
          variant="secondary"
          aria-label="Next month"
          disabled={!data?.canGoForward}
          onClick={() => shift(1)}
        >
          <ChevronRight className="size-5" aria-hidden />
        </Button>
      </div>

      {error ? (
        <p className="py-8 text-center text-sm text-danger-text">{error}</p>
      ) : data === null ? (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Spinner /> Loading&hellip;
        </p>
      ) : mode === "calendar" ? (
        <>
          <div className="grid grid-cols-7 gap-1 text-center">
            {WEEKDAY_INITIALS.map((initial, i) => (
              <span
                key={`${initial}-${i}`}
                className="pb-1 text-xs font-medium uppercase text-muted-foreground"
              >
                {initial}
              </span>
            ))}
            {Array.from({ length: leadingBlanks(data.days[0]?.date) }, (_, i) => (
              <span key={`blank-${i}`} aria-hidden />
            ))}
            {data.days.map((day) => (
              <div
                key={day.date}
                className={`flex flex-col items-center rounded-lg border border-border py-2 ${TONE[day.status] ?? ""}`}
              >
                <span className="text-[11px] text-muted-foreground">{day.day}</span>
                <span className="text-base font-semibold">{LETTER[day.status] ?? "·"}</span>
              </div>
            ))}
          </div>
          <p className="text-center text-xs text-muted-foreground">
            P present &middot; I checked in &middot; &frac12; half day &middot; A absent &middot; L
            paid leave &middot; U unpaid &middot; W week off &middot; H holiday
          </p>
        </>
      ) : (
        <dl className="divide-y divide-border rounded-xl border border-border text-lg">
          {(
            [
              ["Days in the month", data.daysInMonth],
              ["Working days", data.workingDays],
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
            <div key={label} className="flex items-center justify-between px-4 py-2.5">
              <dt>{label}</dt>
              <dd className="tabular font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
