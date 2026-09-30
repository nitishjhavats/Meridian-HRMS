"use client";

import { useCallback, useEffect, useState } from "react";
import { Network } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/stat";
import { Alert, EmptyState, LoadFailed, Spinner } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { formatDate } from "@/lib/utils";

/**
 * Who reports to whom, across the whole organisation.
 *
 * `GET/POST/PATCH /api/settings/structure/reporting` has existed since the
 * structure service was written and had **no caller anywhere in the product** —
 * so `ReportingRelationship` was empty in every organisation created through
 * it, every `.team` scope resolved to one person, and every leave request fell
 * to the HR fallback. A line is created on the employee form; this is where you
 * see all of them and end one.
 *
 * Ending is a date, never a delete. A manager who approved leave last March
 * must still be the manager who approved it.
 *
 * Adding one is here too, and it is the only way a **secondary** line can be
 * created at all. The employee form sets the primary manager and nothing else;
 * `POST /api/settings/structure/reporting` has always accepted a type and had
 * no caller, while this screen has always rendered a "secondary" badge for a
 * kind of line the product gave nobody a way to make. A dotted-line manager --
 * a matrix report, somebody covering a team for three months -- is an ordinary
 * thing an organisation needs to record.
 */

interface Person {
  id: string;
  name: string;
}

interface Draft {
  employeeId: string;
  managerId: string;
  type: "PRIMARY" | "SECONDARY";
  startDate: string;
}

const EMPTY_DRAFT: Draft = { employeeId: "", managerId: "", type: "SECONDARY", startDate: "" };

interface Line {
  id: string;
  employee: { id: string; name: string; employeeCode: string };
  manager: { id: string; name: string; employeeCode: string };
  type: string;
  startDate: string | null;
  endDate: string | null;
}

export function ReportingLines({ canWrite }: { canWrite: boolean }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [linesError, setLinesError] = useState<unknown>(null);
  /** `null` until the options have come back, so an empty list means empty. */
  const [people, setPeople] = useState<Person[] | null>(null);
  const [peopleError, setPeopleError] = useState<unknown>(null);
  const [ending, setEnding] = useState<string | null>(null);
  const [endDate, setEndDate] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLinesError(null);
    try {
      const result = await api<{ lines: Line[] }>("/api/settings/structure/reporting");
      setLines(result.lines);
    } catch (error) {
      setLinesError(error);
    }
  }, []);

  /**
   * The same active-employee list the employee form picks a manager from, so
   * the two screens can never offer different people.
   *
   * A failure is kept. It used to be swallowed, and "Add a line" then opened
   * two pickers with nobody in them and a button that could never enable --
   * no hint that the list had been refused rather than that the directory was
   * empty. The form now says which, and offers a retry when that could help.
   */
  const loadPeople = useCallback(async () => {
    setPeopleError(null);
    try {
      const result = await api<{ managers: Person[] }>("/api/employees/options");
      setPeople(result.managers);
    } catch (error) {
      setPeopleError(error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (canWrite) void loadPeople();
  }, [canWrite, loadPeople]);

  async function end(id: string) {
    setBusy(true);
    const done = await mutate(
      () =>
        api("/api/settings/structure/reporting", {
          method: "PATCH",
          body: { id, endDate },
        }),
      { success: "Line ended. Their history is kept.", error: "Nothing changed" },
    );
    setBusy(false);
    if (done) {
      setEnding(null);
      setEndDate("");
      await load();
    }
  }

  async function add() {
    setBusy(true);
    const done = await mutate(
      () =>
        api("/api/settings/structure/reporting", {
          method: "POST",
          body: {
            employeeId: draft.employeeId,
            managerId: draft.managerId,
            type: draft.type,
            startDate: draft.startDate,
          },
        }),
      { success: "Line added.", error: "Nothing was added" },
    );
    setBusy(false);
    if (done) {
      setAdding(false);
      setDraft(EMPTY_DRAFT);
      await load();
    }
  }

  const canSubmit =
    draft.employeeId !== "" &&
    draft.managerId !== "" &&
    draft.employeeId !== draft.managerId &&
    draft.startDate !== "";

  const live = (lines ?? []).filter((l) => !l.endDate);
  const past = (lines ?? []).filter((l) => l.endDate);

  return (
    <Section
      title="Reporting lines"
      description="Who approves whose leave and attendance corrections. Set on the employee, listed here."
    >
      <div className="space-y-4 p-4">
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={adding ? "ghost" : "secondary"}
              disabled={busy}
              onClick={() => {
                setAdding((open) => !open);
                setDraft({ ...EMPTY_DRAFT, startDate: new Date().toISOString().slice(0, 10) });
              }}
            >
              {adding ? "Cancel" : "Add a line"}
            </Button>
            {!adding ? (
              <span className="text-xs text-muted-foreground">
                A primary manager is normally set on the employee. Add one here to record a second,
                dotted-line manager.
              </span>
            ) : null}
          </div>
        ) : null}

        {adding && canWrite ? (
          <div className="space-y-3 rounded-md border border-dashed border-border p-3">
            {peopleError !== null ? (
              <LoadFailed
                compact
                error={peopleError}
                what="The list of people"
                onRetry={() => void loadPeople()}
              />
            ) : people === null ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner /> Loading the people to choose from…
              </p>
            ) : people.length === 0 ? (
              <Alert tone="info" title="Nobody to choose from yet">
                A line joins two active employees, and there are none in the directory. Add
                people first and come back.
              </Alert>
            ) : null}

            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <Field label="Who reports" htmlFor="lineEmployee">
                <Select
                  id="lineEmployee"
                  value={draft.employeeId}
                  disabled={people === null || people.length === 0}
                  onChange={(e) => setDraft((d) => ({ ...d, employeeId: e.target.value }))}
                >
                  <option value="">Choose somebody…</option>
                  {(people ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Reports to"
                htmlFor="lineManager"
                hint="Nobody can report to themselves."
              >
                <Select
                  id="lineManager"
                  value={draft.managerId}
                  disabled={people === null || people.length === 0}
                  onChange={(e) => setDraft((d) => ({ ...d, managerId: e.target.value }))}
                >
                  <option value="">Choose a manager…</option>
                  {(people ?? [])
                    .filter((p) => p.id !== draft.employeeId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field
                label="Kind of line"
                htmlFor="lineType"
                hint="A primary line replaces the one in force and ends it on the day before this starts."
              >
                <Select
                  id="lineType"
                  value={draft.type}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, type: e.target.value as Draft["type"] }))
                  }
                >
                  <option value="SECONDARY">Secondary — a dotted-line manager</option>
                  <option value="PRIMARY">Primary — approves their leave and attendance</option>
                </Select>
              </Field>
              <Field label="In force from" htmlFor="lineStart">
                <Input
                  id="lineStart"
                  type="date"
                  value={draft.startDate}
                  onChange={(e) => setDraft((d) => ({ ...d, startDate: e.target.value }))}
                />
              </Field>
            </div>
            <Button size="sm" disabled={busy || !canSubmit} onClick={() => void add()}>
              Add the line
            </Button>
          </div>
        ) : null}

        {linesError !== null ? (
          <LoadFailed
            compact
            error={linesError}
            what="Reporting lines"
            onRetry={() => void load()}
          />
        ) : lines === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Loading…
          </p>
        ) : lines.length === 0 ? (
          <EmptyState
            icon={Network}
            title="Nobody reports to anybody yet"
            description="Set a manager on an employee's record. Until then, leave and attendance corrections go to HR and your administrators."
          />
        ) : (
          <>
            {live.length === 0 ? (
              <Alert tone="warning" title="No line is currently in force">
                Every approval is falling through to HR and your administrators.
              </Alert>
            ) : null}

            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {[...live, ...past].map((line) => (
                <li key={line.id} className="space-y-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-medium">{line.employee.name}</span>
                      <span className="text-muted-foreground"> reports to </span>
                      <span className="font-medium">{line.manager.name}</span>
                    </span>
                    {line.type !== "PRIMARY" ? <Badge tone="neutral">secondary</Badge> : null}
                    {line.endDate ? (
                      <Badge tone="neutral">ended {formatDate(line.endDate)}</Badge>
                    ) : (
                      <Badge tone="success">in force</Badge>
                    )}
                    {canWrite && !line.endDate ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setEnding(ending === line.id ? null : line.id);
                          setEndDate(new Date().toISOString().slice(0, 10));
                        }}
                      >
                        {ending === line.id ? "Cancel" : "End it"}
                      </Button>
                    ) : null}
                  </div>

                  {ending === line.id ? (
                    <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border p-3">
                      <Field
                        label="Last day as their manager"
                        htmlFor={`end-${line.id}`}
                        hint="Kept, not deleted — approvals they already gave stay theirs."
                      >
                        <Input
                          id={`end-${line.id}`}
                          type="date"
                          value={endDate}
                          onChange={(e) => setEndDate(e.target.value)}
                        />
                      </Field>
                      <Button size="sm" disabled={busy || !endDate} onClick={() => void end(line.id)}>
                        End the line
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Section>
  );
}
