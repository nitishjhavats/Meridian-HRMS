"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, GraduationCap, Plus, SkipForward, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { formatDate } from "@/lib/utils";
import { resolveChoice, splitByJoiningDate } from "@/domain/onboarding/template";
import { Templates, type Template } from "./Templates";

/**
 * Onboarding, grouped by person rather than by task.
 *
 * A flat task list would sort by due date and interleave four joiners, which is
 * exactly wrong: onboarding is experienced one person at a time, and the
 * question is always "where is this person up to".
 */

export interface Task {
  id: string;
  title: string;
  description: string | null;
  dueOn: string | null;
  status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "SKIPPED";
  overdue: boolean;
  employee: { id: string; name: string; code: string; joiningDate: string | null };
}

export type { Template };

export function Onboarding({
  tasks,
  templates,
  employees,
}: {
  tasks: Task[];
  templates: Template[];
  employees: { id: string; name: string; code: string; joiningDate: string | null }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [chosen, setChosen] = useState({ employeeId: "", templateId: "" });

  // Somebody with no joining date has nothing to schedule against, so they are
  // not offered at all and the reason is printed instead. They used to be
  // offered and then refused by the server — and since the list arrives sorted
  // by joining date descending, Postgres puts the undated rows first, so the
  // person pre-selected in the box was usually one of the ones that could not
  // work.
  const { ready, undated } = splitByJoiningDate(employees);

  // Derived, never stored: state seeded from an empty list stays empty, and
  // `router.refresh()` re-renders the server component without resetting client
  // state. That is why the Template box showed a template and the Set-up button
  // stayed disabled once the first template existed.
  const employee = resolveChoice(ready, chosen.employeeId);
  const template = resolveChoice(templates, chosen.templateId);
  const steps = template?.tasks.length ?? 0;

  // Group by person, preserving the order the server sorted in.
  const byEmployee = new Map<string, { employee: Task["employee"]; tasks: Task[] }>();
  for (const task of tasks) {
    const entry = byEmployee.get(task.employee.id) ?? { employee: task.employee, tasks: [] };
    entry.tasks.push(task);
    byEmployee.set(task.employee.id, entry);
  }

  async function act(key: string, body: unknown, success: string) {
    setBusy(key);
    const ok = await mutate(() => api("/api/onboarding", { method: "POST", body }), {
      success,
      error: "That did not work",
    });
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  const templatesPanel = <Templates templates={templates} />;

  const setUp = (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Set up a new joiner</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Copies a template into a dated checklist for one person. Nothing is shared afterwards —
        editing the template later does not move anybody&rsquo;s dates.
      </p>

      {ready.length === 0 || templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {templates.length === 0
            ? "There is no template to apply yet. Create one below and it will appear here."
            : "No employee has a joining date, so there is nothing to schedule from. Add a joining date on an employee record first."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Employee" htmlFor="obEmployee">
              <Select
                id="obEmployee"
                value={employee?.id ?? ""}
                onChange={(e) => setChosen((a) => ({ ...a, employeeId: e.target.value }))}
              >
                {ready.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.code}) — joins {e.joiningDate}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Template" htmlFor="obTemplate">
              <Select
                id="obTemplate"
                value={template?.id ?? ""}
                onChange={(e) => setChosen((a) => ({ ...a, templateId: e.target.value }))}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.tasks.length} steps)
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              loading={busy === "apply"}
              disabled={!employee || !template || steps === 0}
              onClick={() => {
                if (!employee || !template) return;
                act(
                  "apply",
                  { action: "apply", employeeId: employee.id, templateId: template.id },
                  "Onboarding set up.",
                );
              }}
            >
              <Plus className="size-4" aria-hidden />
              Set up
            </Button>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            {steps === 0
              ? `${template?.name ?? "That template"} has no steps yet — add one below before using it.`
              : `Creates ${steps} dated ${steps === 1 ? "task" : "tasks"} for ${employee?.name}, counted from ${formatDate(employee?.joiningDate)}.`}
          </p>
        </>
      )}

      {undated.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {undated.length} {undated.length === 1 ? "employee is" : "employees are"} missing from
          this list because there is no joining date on their record. Every step is dated from that
          day, so add it there first.
        </p>
      ) : null}
    </div>
  );

  const people =
    byEmployee.size === 0 ? (
      <EmptyState
        icon={GraduationCap}
        title="Nobody is being onboarded"
        description="Onboarding is the checklist a new joiner needs — paperwork, accounts, laptop, first-week check-ins — each dated from the day they start. Pick a template and an employee above to create theirs."
      />
    ) : (
      [...byEmployee.values()].map(({ employee: person, tasks: theirs }) => {
        const done = theirs.filter((t) => t.status === "COMPLETED" || t.status === "SKIPPED").length;
        const overdue = theirs.filter((t) => t.overdue).length;

        return (
          <section key={person.id} className="rounded-lg border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">{person.name}</h2>
                <p className="text-xs text-muted-foreground">
                  {person.code}
                  {person.joiningDate ? ` · joined ${formatDate(person.joiningDate)}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {overdue > 0 ? (
                  <Badge tone="danger">
                    <TriangleAlert className="size-3" aria-hidden />
                    {overdue} overdue
                  </Badge>
                ) : null}
                <Badge tone={done === theirs.length ? "success" : "neutral"}>
                  {done}/{theirs.length}
                </Badge>
              </div>
            </div>

            <ul className="divide-y divide-border">
              {theirs.map((task) => {
                const complete = task.status === "COMPLETED" || task.status === "SKIPPED";
                return (
                  <li key={task.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className={`text-sm ${complete ? "text-muted-foreground line-through" : ""}`}>
                        {task.title}
                      </span>
                      {task.dueOn ? (
                        <span
                          className={`block text-xs ${task.overdue ? "text-danger-text" : "text-muted-foreground"}`}
                        >
                          due {formatDate(task.dueOn)}
                        </span>
                      ) : null}
                    </span>

                    {task.status === "SKIPPED" ? <Badge tone="neutral">skipped</Badge> : null}

                    {!complete ? (
                      <span className="flex shrink-0 gap-1.5">
                        <Button
                          size="sm"
                          variant="success"
                          loading={busy === task.id}
                          title="Done"
                          onClick={() =>
                            act(task.id, { action: "set", taskId: task.id, status: "COMPLETED" }, "Done.")
                          }
                        >
                          <Check className="size-4" aria-hidden />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Not applicable"
                          onClick={() =>
                            act(task.id, { action: "set", taskId: task.id, status: "SKIPPED" }, "Skipped.")
                          }
                        >
                          <SkipForward className="size-4" aria-hidden />
                        </Button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })
    );

  return (
    <div className="space-y-4">
      {setUp}
      {/* While there are no templates, the templates panel is the only thing on
          this page anybody can act on, so it goes above the empty list. */}
      {templates.length === 0 ? templatesPanel : null}
      {people}
      {templates.length > 0 ? templatesPanel : null}
    </div>
  );
}
