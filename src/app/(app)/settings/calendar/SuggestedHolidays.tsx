"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, TriangleAlert } from "lucide-react";
import { Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { formatDate } from "@/lib/utils";

/**
 * The holidays most Indian organisations want, ready to switch on.
 *
 * A new organisation used to get none at all, so setting up a calendar meant
 * typing Republic Day into a form — and a holiday decides whether a day is
 * payable, so an office that never got round to it was marking people absent
 * on Independence Day.
 *
 * Switching one on adds it **and announces it**, because a holiday nobody is
 * told about is a day half the office comes in.
 */

interface Row {
  key: string;
  name: string;
  date: string;
  verify: boolean;
  added: boolean;
  clashesWith: string | null;
  /** A gazetted national day: on by default, added again every year, switchable. */
  defaultOn: boolean;
}

interface Payload {
  year: number;
  years: number[];
  festivalDatesKnown: boolean;
  rows: Row[];
}

export function SuggestedHolidays({ canWrite }: { canWrite: boolean }) {
  const [year, setYear] = useState(() => new Date().getUTCFullYear());
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback((forYear: number) => {
    void api<Payload>(`/api/settings/calendar/suggested?year=${forYear}`)
      .then(setData)
      .catch(() => undefined);
  }, []);

  useEffect(() => load(year), [load, year]);

  async function toggle(row: Row, on: boolean) {
    setBusy(row.key);
    const result = await mutate<Payload>(
      () =>
        api("/api/settings/calendar/suggested", {
          method: "PATCH",
          body: { year, key: row.key, on },
        }),
      {
        success: on ? `${row.name} added, and announced.` : `${row.name} removed.`,
        error: "Nothing changed",
      },
    );
    setBusy(null);
    if (result) setData(result);
  }

  return (
    <Section
      title="Suggested holidays"
      description="The national days and the main festivals. The three national days arrive on and come back every year; switch one off and it stays off. Switching one on adds it to the calendar and posts an announcement."
    >
      <div className="space-y-4 p-4">
        <Field label="Year" htmlFor="holidayYear">
          <Select
            id="holidayYear"
            className="max-w-40"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {(data?.years ?? [year]).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </Field>

        {data && !data.festivalDatesKnown ? (
          <Alert tone="info" title="Only the national days for this year">
            The festival dates follow the lunar calendar and are published a few years ahead. Add
            them by hand for this year, or come back when the list is extended.
          </Alert>
        ) : null}

        {data === null ? (
          <p className="text-sm text-muted-foreground">Loading&hellip;</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.rows.map((row) => (
              <li key={row.key} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  <CalendarPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{row.name}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(row.date)}</p>
                    {row.clashesWith ? (
                      <p className="flex items-center gap-1 text-xs text-warning-text">
                        <TriangleAlert className="size-3 shrink-0" aria-hidden />
                        {row.clashesWith} is already on that date
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Said on every lunar date, added or not. These follow the
                      lunar calendar and a regional calendar can differ by a
                      day, so the product asks rather than deciding somebody was
                      absent on a day the office was shut. */}
                  {row.verify ? <Badge tone="warning">Check this date</Badge> : null}
                  {/* Says where it came from, and stays switchable. These
                      three arrive on and arrive again every year; off is a real
                      answer, and once off the yearly job leaves it off. */}
                  {row.defaultOn ? <Badge tone="neutral">On by default</Badge> : null}
                  <Switch
                    checked={row.added}
                    disabled={!canWrite || busy === row.key || Boolean(row.clashesWith)}
                    aria-label={`${row.name} on ${formatDate(row.date)}`}
                    onCheckedChange={(on) => void toggle(row, on)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
