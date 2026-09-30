"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { MONTH_NAMES } from "@/domain/date";

/**
 * Opening a payroll month.
 *
 * Defaults to the last *finished* month, which is what an admin wants nine times
 * out of ten. A month still in progress is refused by the server — payroll for a
 * period that is not over is guesswork.
 */
export function OpenMonth({
  defaultYear,
  defaultMonth,
  suggestionOpen,
  suggestionLabel,
}: {
  defaultYear: number;
  defaultMonth: number;
  suggestionOpen: boolean;
  suggestionLabel: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(defaultYear);
  const [month, setMonth] = useState(defaultMonth);
  const [busy, setBusy] = useState(false);

  const years = [defaultYear + 1, defaultYear, defaultYear - 1, defaultYear - 2];

  async function create() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ run: { id: string } }>("/api/payroll/runs", {
          method: "POST",
          body: { year, month },
        }),
      { error: "That month could not be opened" },
    );
    setBusy(false);
    if (result) {
      setOpen(false);
      router.push(`/payroll/${result.run.id}`);
      router.refresh();
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <CalendarPlus className="size-4" aria-hidden />
        Open a month
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open a payroll month</DialogTitle>
            <DialogDescription>
              Opening a month does not calculate it — you will see who is included first.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {!suggestionOpen ? (
              <Alert tone="info">
                {suggestionLabel} has finished and has not been run yet.
              </Alert>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Month" htmlFor="month" required>
                <Select
                  id="month"
                  value={month}
                  onChange={(e) => setMonth(Number(e.target.value))}
                >
                  {MONTH_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Year" htmlFor="year" required>
                <Select id="year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={create}>
              Open {MONTH_NAMES[month - 1]} {year}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
