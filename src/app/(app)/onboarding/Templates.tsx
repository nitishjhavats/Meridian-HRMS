"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { offsetLabel, toOffsetDays, type StepTiming } from "@/domain/onboarding/template";

/**
 * The templates themselves: create, rename, and edit the steps.
 *
 * None of this had a screen. `OnboardingTemplateTask` rows could only ever be
 * the ten the service seeds, the create control rendered only while the
 * organisation had zero templates — so a second one could never be made — and
 * `deleteTemplate` had nothing that called it.
 *
 * Every template is shown expanded rather than behind an accordion. An
 * organisation has two or three of these, and the question being asked of this
 * screen is "what is actually in them", which a row of collapsed names does not
 * answer.
 */

export interface TemplateStep {
  id: string;
  title: string;
  description: string | null;
  dueOffsetDays: number;
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  /** How many people have been set up from it; it is not removed lightly. */
  issued: number;
  tasks: TemplateStep[];
}

interface StepDraft {
  title: string;
  timing: StepTiming;
  days: number | null;
}

const EMPTY_DRAFT: StepDraft = { title: "", timing: "on", days: 1 };

export function Templates({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [start, setStart] = useState<"starter" | "blank">("starter");

  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, StepDraft>>({});

  const draftFor = (id: string) => drafts[id] ?? EMPTY_DRAFT;
  const setDraft = (id: string, patch: Partial<StepDraft>) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? EMPTY_DRAFT), ...patch } }));

  async function act(key: string, body: unknown, success: string): Promise<boolean> {
    setBusy(key);
    const ok = await mutate(() => api("/api/onboarding/templates", { method: "POST", body }), {
      success,
      error: "That did not work",
    });
    setBusy(null);
    if (ok !== null) router.refresh();
    return ok !== null;
  }

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Templates</h2>
          <p className="text-xs text-muted-foreground">
            A template is the checklist for one kind of joiner. Each step is dated from the day
            they start.
          </p>
        </div>
        <Badge tone="neutral">{templates.length} saved</Badge>
      </div>

      {/* ---------- new template ---------- */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 border-b border-border p-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <Field
          label="New template"
          htmlFor="obNewTemplate"
          hint="For example: Standard joiner, or Factory floor."
        >
          <Input
            id="obNewTemplate"
            value={name}
            placeholder="Name it"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Start with" htmlFor="obNewTemplateStart">
          <Select
            id="obNewTemplateStart"
            value={start}
            onChange={(e) => setStart(e.target.value === "blank" ? "blank" : "starter")}
          >
            <option value="starter">The usual ten steps</option>
            <option value="blank">No steps — I will add them</option>
          </Select>
        </Field>
        <Button
          loading={busy === "create"}
          disabled={name.trim().length < 2}
          onClick={async () => {
            const created = await act(
              "create",
              { action: "create", name: name.trim(), blank: start === "blank" },
              start === "blank" ? "Template created. Add its steps below." : "Template created.",
            );
            if (created) setName("");
          }}
        >
          <Plus className="size-4" aria-hidden />
          Create
        </Button>
      </div>

      {templates.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No templates yet"
          description="Name one above and you get the usual ten steps — offer letter, documents, bank details, laptop, first-week check-in — which you can then edit. One template has to exist before anybody can be set up."
        />
      ) : (
        <ul className="divide-y divide-border">
          {templates.map((template) => {
            const draft = draftFor(template.id);
            return (
              <li key={template.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {renaming === template.id ? (
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      <Input
                        value={renameTo}
                        aria-label="Template name"
                        className="min-w-40 flex-1"
                        onChange={(e) => setRenameTo(e.target.value)}
                      />
                      <Button
                        size="sm"
                        loading={busy === `rename:${template.id}`}
                        disabled={renameTo.trim().length < 2}
                        onClick={async () => {
                          const done = await act(
                            `rename:${template.id}`,
                            { action: "rename", id: template.id, name: renameTo.trim() },
                            "Renamed.",
                          );
                          if (done) setRenaming(null);
                        }}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                        <X className="size-4" aria-hidden />
                      </Button>
                    </div>
                  ) : (
                    <div className="min-w-0">
                      <h3 className="text-sm font-semibold">{template.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {template.tasks.length} {template.tasks.length === 1 ? "step" : "steps"}
                        {template.issued > 0 ? ` · used ${template.issued} times` : ""}
                      </p>
                    </div>
                  )}

                  {renaming === template.id ? null : (
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Rename"
                        onClick={() => {
                          setRenaming(template.id);
                          setRenameTo(template.name);
                        }}
                      >
                        <Pencil className="size-4" aria-hidden />
                      </Button>
                      {confirming === template.id ? (
                        <>
                          <Button
                            size="sm"
                            variant="danger"
                            loading={busy === `delete:${template.id}`}
                            onClick={async () => {
                              const done = await act(
                                `delete:${template.id}`,
                                { action: "delete", id: template.id },
                                "Template removed.",
                              );
                              if (done) setConfirming(null);
                            }}
                          >
                            Remove it
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Remove this template"
                          onClick={() => setConfirming(template.id)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      )}
                    </div>
                  )}
                </div>

                {template.tasks.length === 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    This template has no steps, so it cannot be applied to anybody yet. Add the
                    first one below.
                  </p>
                ) : (
                  <ol className="mt-3 divide-y divide-border rounded-md border border-border">
                    {template.tasks.map((step, index) => (
                      <li key={step.id} className="flex items-center gap-2 px-3 py-2">
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm">{step.title}</span>
                          <span className="block text-xs text-muted-foreground">
                            {offsetLabel(step.dueOffsetDays)}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Move up"
                            disabled={index === 0}
                            onClick={() =>
                              act(
                                `move:${step.id}`,
                                {
                                  action: "moveStep",
                                  templateId: template.id,
                                  stepId: step.id,
                                  direction: -1,
                                },
                                "Moved.",
                              )
                            }
                          >
                            <ArrowUp className="size-4" aria-hidden />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Move down"
                            disabled={index === template.tasks.length - 1}
                            onClick={() =>
                              act(
                                `move:${step.id}`,
                                {
                                  action: "moveStep",
                                  templateId: template.id,
                                  stepId: step.id,
                                  direction: 1,
                                },
                                "Moved.",
                              )
                            }
                          >
                            <ArrowDown className="size-4" aria-hidden />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Remove this step"
                            loading={busy === `step:${step.id}`}
                            onClick={() =>
                              act(
                                `step:${step.id}`,
                                { action: "removeStep", templateId: template.id, stepId: step.id },
                                "Step removed.",
                              )
                            }
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}

                {/* ---------- add a step ---------- */}
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[2fr_auto_auto_auto] sm:items-end">
                  <Field label="Add a step" htmlFor={`obStep-${template.id}`}>
                    <Input
                      id={`obStep-${template.id}`}
                      value={draft.title}
                      placeholder="What has to happen"
                      onChange={(e) => setDraft(template.id, { title: e.target.value })}
                    />
                  </Field>
                  <Field label="When" htmlFor={`obTiming-${template.id}`}>
                    <Select
                      id={`obTiming-${template.id}`}
                      value={draft.timing}
                      onChange={(e) =>
                        setDraft(template.id, { timing: e.target.value as StepTiming })
                      }
                    >
                      <option value="before">Days before joining</option>
                      <option value="on">On the joining day</option>
                      <option value="after">Days after joining</option>
                    </Select>
                  </Field>
                  <Field label="Days" htmlFor={`obDays-${template.id}`}>
                    <NumberField
                      id={`obDays-${template.id}`}
                      className="sm:w-20"
                      value={draft.timing === "on" ? 0 : draft.days}
                      disabled={draft.timing === "on"}
                      min={0}
                      max={365}
                      onValueChange={(days) => setDraft(template.id, { days })}
                    />
                  </Field>
                  <Button
                    variant="secondary"
                    loading={busy === `add:${template.id}`}
                    disabled={draft.title.trim().length < 2}
                    onClick={async () => {
                      const added = await act(
                        `add:${template.id}`,
                        {
                          action: "addStep",
                          templateId: template.id,
                          title: draft.title.trim(),
                          dueOffsetDays: toOffsetDays(draft.timing, draft.days),
                        },
                        "Step added.",
                      );
                      if (added) setDraft(template.id, { title: "" });
                    }}
                  >
                    <Plus className="size-4" aria-hidden />
                    Add
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
