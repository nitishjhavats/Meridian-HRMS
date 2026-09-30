"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, FileSignature, FileText, Save, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequestFailed, api, mutate } from "@/lib/client/api";
import { employeeName } from "@/domain/employees/name";

/**
 * Composing a letter.
 *
 * The editor holds a *template* — text with `{{placeholders}}` — and the
 * preview shows it filled with that employee's real values. Keeping the two
 * visible together is the point: it is the only way somebody can tell that
 * "{{salary.annualCtc}}" will actually resolve before the letter goes out.
 *
 * One composition is one draft. The first act that needs a row on the server
 * -- a PDF preview, a save, an issue -- creates it, and every later act writes
 * to that same row. Creating a fresh letter each time gave every "Preview the
 * PDF" its own number in the Drafts list, and the letter finally issued yet
 * another; the leftovers had to be deleted one by one.
 *
 * An existing draft is reopened here too, by `/letters?draft=<id>`. Without
 * that a draft that could not be issued -- a notice period nobody typed --
 * had no way out but the bin and a retype.
 */

interface EmployeeOption {
  id: string;
  name: string;
  code: string;
}

const CATEGORIES = [
  { value: "EXPERIENCE", label: "Experience certificate" },
  { value: "OFFER", label: "Offer letter" },
  { value: "APPOINTMENT", label: "Appointment letter" },
  { value: "CONFIRMATION", label: "Confirmation letter" },
  { value: "PROMOTION", label: "Promotion letter" },
  { value: "INCREMENT", label: "Increment letter" },
  { value: "RELIEVING", label: "Relieving letter" },
  { value: "WARNING", label: "Warning letter" },
  { value: "TERMINATION", label: "Termination letter" },
  { value: "OTHER", label: "Other" },
];

interface Preview {
  text: string;
  problems: { key: string; kind: string; message: string }[];
  canIssue: boolean;
  /** Resolved server-side: the framework's choice, else whoever is issuing it. */
  signatory: { name: string | null; title: string | null };
}

/** What `GET /api/letters/:id` answers, as far as reopening a draft needs. */
interface StoredLetter {
  id: string;
  letterNumber: string;
  status: "DRAFT" | "ISSUED" | "REVOKED";
  employeeId: string;
  category: string;
  subject: string;
  body: string;
  aiPrompt: string | null;
  aiModel: string | null;
  variables: { filled?: Record<string, string> } | null;
  employee: {
    id: string;
    employeeCode: string;
    firstName: string | null;
    lastName: string | null;
    user: { name: string | null } | null;
  };
}

/** The draft this composition is bound to, once it has one. */
interface BoundDraft {
  id: string;
  letterNumber: string;
  /** Opened from the list rather than created here. */
  reopened: boolean;
}

/** The sentinel an option list uses for "none of these". */
const CUSTOM = "__custom__";

export function LetterComposer({
  employees,
  aiAvailable,
  placeholders,
  suggestions,
}: {
  employees: EmployeeOption[];
  aiAvailable: boolean;
  placeholders: { key: string; label: string }[];
  /** Placeholder key to the organisation's own values for it, where it has any. */
  suggestions: Record<string, string[]>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    employeeId: employees[0]?.id ?? "",
    category: "EXPERIENCE",
    subject: "Experience certificate",
    body: "",
    aiPrompt: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiModel, setAiModel] = useState<string | null>(null);
  /** Which fields the author has chosen to type freely rather than pick. */
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  /**
   * Placeholders no column can answer — a notice period, a reason, a date that
   * is not the joining date.
   *
   * Without somewhere to type these, a letter that needs one could never be
   * issued at all: `canIssue` requires every placeholder to resolve, and a
   * missing value counts as a problem. They are stored on the draft and merged
   * over the record when it is issued.
   */
  const [filled, setFilled] = useState<Record<string, string>>({});
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const [bound, setBound] = useState<BoundDraft | null>(null);
  /**
   * The person a reopened draft is for, when they are no longer on the active
   * list. The draft is theirs whether or not they are still employed, and the
   * select has to be able to show who.
   */
  const [extraEmployee, setExtraEmployee] = useState<EmployeeOption | null>(null);

  /**
   * `/letters?draft=<id>` opens that draft for editing.
   *
   * Read from the address rather than passed down, because the list that
   * links here and this editor are two components on one server page with
   * nothing between them but the URL. Watched rather than read once on
   * arrival: the list's "Edit" is a link to the very page this editor is
   * already mounted on, so the address changes under a component that never
   * remounts, and a one-time read would have seen nothing. Anything that is
   * not a draft any more is simply not opened: the list is the place to see
   * why.
   */
  const draftId = useSearchParams().get("draft");
  useEffect(() => {
    const id = draftId;
    if (!id) return;
    let cancelled = false;
    void (async () => {
      const result = await api<{ letter: StoredLetter }>(`/api/letters/${id}`).catch(() => null);
      if (cancelled) return;
      const letter = result?.letter;
      if (!letter || letter.status !== "DRAFT") {
        router.replace("/letters");
        return;
      }
      const stored = letter.variables?.filled ?? {};
      setForm({
        employeeId: letter.employeeId,
        category: letter.category,
        subject: letter.subject,
        body: letter.body,
        aiPrompt: letter.aiPrompt ?? "",
      });
      setFilled(stored);
      setAiModel(letter.aiModel);
      setBound({ id: letter.id, letterNumber: letter.letterNumber, reopened: true });
      setExtraEmployee(
        employees.some((e) => e.id === letter.employeeId)
          ? null
          : {
              id: letter.employee.id,
              name: employeeName(letter.employee, "—"),
              code: letter.employee.employeeCode,
            },
      );
      setOpen(true);
      // The preview is what says whether it can be issued yet, and the
      // fill-in form hangs off it -- which is the whole reason for reopening.
      await fetchPreview({
        employeeId: letter.employeeId,
        category: letter.category,
        body: letter.body,
        filled: stored,
      });
    })();
    return () => {
      cancelled = true;
    };
    // Only the address is watched. The employee list and the preview are read
    // as they stand when it changes, not re-run every time they do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  /** Load this letter type's framework into the editor. */
  async function useTemplate() {
    setLoadingTemplate(true);
    const result = await api<{ current: { subject: string; body: string } }>(
      `/api/letters/templates/${form.category}`,
    ).catch(() => null);
    setLoadingTemplate(false);
    if (result) {
      setForm((f) => ({ ...f, subject: result.current.subject, body: result.current.body }));
      setPreview(null);
      setAiModel(null);
    }
  }

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /**
   * Who the letter is for, and what kind it is.
   *
   * Both are fixed once a draft is numbered: the number carries the type's
   * prefix, and the server will not move a draft to another person. A draft
   * this composition created for a PDF preview is therefore let go when either
   * changes -- deleted, since the person never asked to keep it, and the next
   * preview or save starts a fresh one. A draft reopened from the list is
   * theirs to keep, so those two selects are disabled instead.
   */
  function rebind(patch: { employeeId?: string; category?: string; subject?: string }) {
    setForm((f) => ({ ...f, ...patch }));
    setPreview(null);
    if (bound && !bound.reopened) {
      const stale = bound.id;
      setBound(null);
      void api(`/api/letters/${stale}`, { method: "DELETE" })
        .catch(() => null)
        .then(() => router.refresh());
    }
  }

  async function draft() {
    setDrafting(true);
    setError(null);
    try {
      const result = await api<{
        draft: { body: string; subject: string; preview: string; problems: Preview["problems"]; model: string; tokensUsed: number };
      }>("/api/letters/draft", {
        method: "POST",
        body: {
          employeeId: form.employeeId,
          category: form.category,
          prompt: form.aiPrompt,
        },
      });
      setForm((f) => ({ ...f, body: result.draft.body, subject: result.draft.subject }));
      setPreview({
        text: result.draft.preview,
        problems: result.draft.problems,
        canIssue: result.draft.problems.length === 0,
        // The draft endpoint does not resolve a signatory; the next preview
        // refresh fills these in. Kept null rather than guessed so the boxes
        // below stay empty instead of showing a name nobody chose.
        signatory: { name: null, title: null },
      });
      setAiModel(`${result.draft.model} · ${result.draft.tokensUsed} tokens`);
    } catch (err) {
      setError(err instanceof RequestFailed ? err.error.message : "We could not reach the server.");
    } finally {
      setDrafting(false);
    }
  }

  /**
   * Renders the editor against the record and returns what came back, so a
   * caller that has to decide something -- "may this be issued?" -- can read
   * the answer instead of waiting on state.
   */
  async function fetchPreview(
    input: { employeeId: string; category: string; body: string; filled: Record<string, string> } = {
      employeeId: form.employeeId,
      category: form.category,
      body: form.body,
      filled,
    },
  ): Promise<Preview | null> {
    if (!input.body.trim() || !input.employeeId) return null;
    try {
      const result = await api<{ preview: Preview }>("/api/letters/preview", {
        method: "POST",
        body: input,
      });
      setPreview(result.preview);
      // Seed the two signatory boxes from what the server resolved, but never
      // over something already typed -- `filled` is the author's answer and the
      // preview echoes it straight back, so writing it again would be a no-op at
      // best and would fight the cursor at worst.
      setFilled((f) => ({
        "signatory.name": f["signatory.name"] ?? result.preview.signatory.name ?? "",
        "signatory.title": f["signatory.title"] ?? result.preview.signatory.title ?? "",
        ...f,
      }));
      setError(null);
      return result.preview;
    } catch (err) {
      setError(err instanceof RequestFailed ? err.error.message : "Preview failed.");
      return null;
    }
  }

  function refreshPreview() {
    void fetchPreview();
  }

  /**
   * Writes the editor to this composition's draft, creating it the first time.
   *
   * Returns the draft, or null when the server refused (the toast has already
   * said why). Every act that needs a row goes through here, which is what
   * keeps a composition to one number.
   */
  async function persist(messages: { success?: string; error: string }): Promise<BoundDraft | null> {
    if (bound) {
      const saved = await mutate(
        () =>
          api(`/api/letters/${bound.id}`, {
            method: "POST",
            body: { action: "save", subject: form.subject.trim(), body: form.body, filled },
          }),
        messages,
      );
      return saved === null ? null : bound;
    }

    const created = await mutate(
      () =>
        api<{ id: string; letterNumber: string }>("/api/letters", {
          method: "POST",
          body: {
            employeeId: form.employeeId,
            category: form.category,
            subject: form.subject.trim(),
            body: form.body,
            ...(form.aiPrompt.trim() ? { aiPrompt: form.aiPrompt.trim() } : {}),
            ...(aiModel ? { aiModel: aiModel.split(" · ")[0] } : {}),
            filled,
          },
        }),
      messages,
    );
    if (!created) return null;
    const next = { id: created.id, letterNumber: created.letterNumber, reopened: false };
    setBound(next);
    return next;
  }

  /**
   * Look at it before committing to it.
   *
   * Saves the draft first and opens the PDF, because the preview is rendered by
   * the same code that issues — the same letterhead, the same signature block,
   * the same stamp. A preview drawn any other way would be a second opinion
   * about what the letter looks like, and the two would drift.
   *
   * Unresolved placeholders do not stop it. They print as `[Monthly salary]`
   * over a DRAFT watermark, which is exactly what somebody checking a
   * letterhead needs to see.
   */
  async function previewPdf() {
    // The tab is opened now, while this is still the click, and pointed at the
    // PDF once the save has answered. A `window.open` after an awaited fetch
    // is a popup as far as Safari is concerned, and it was blocked silently:
    // the draft was created and the button appeared to do nothing.
    const tab = window.open("", "_blank");
    setBusy(true);
    const letter = await persist({ error: "The draft could not be saved to preview it" });
    setBusy(false);
    if (!letter) {
      tab?.close();
      return;
    }
    // A new tab rather than an inline frame: the browser's own PDF viewer can
    // zoom, page and print, and none of that is worth rebuilding in a dialog.
    const url = `/api/letters/${letter.id}/preview`;
    if (tab) tab.location.href = url;
    else window.open(url, "_blank", "noopener");
  }

  /** Back to the button, with nothing carried over. */
  function finish() {
    setForm((f) => ({
      ...f,
      // A reopened draft may have been for somebody no longer on the list --
      // shown through `extraEmployee`, which goes below. Left in place, that
      // id would sit behind a select showing the first name on the list, and
      // the next letter would be numbered for the person nobody could see.
      employeeId: employees.some((e) => e.id === f.employeeId)
        ? f.employeeId
        : (employees[0]?.id ?? ""),
      body: "",
      aiPrompt: "",
    }));
    setFilled({});
    setTyping({});
    setPreview(null);
    setAiModel(null);
    setBound(null);
    setExtraEmployee(null);
    setError(null);
    setOpen(false);
    // Drop `?draft=` so a reload does not reopen a letter that is now issued.
    if (window.location.search) router.replace("/letters");
    router.refresh();
  }

  async function save(thenIssue: boolean) {
    setBusy(true);

    if (thenIssue) {
      // Issuing is refused server-side while any placeholder is unresolved,
      // so ask first. The preview used to be whatever was last shown -- often
      // nothing, since it only ran when the body lost focus -- and pressing
      // "Save & issue" straight from a template consumed a number, failed,
      // closed the editor and left a draft nobody could issue or edit.
      const latest = await fetchPreview();
      if (!latest) {
        setBusy(false);
        return;
      }
      if (!latest.canIssue) {
        setBusy(false);
        setError("Some placeholders still have no value. Fill them in below, then issue it.");
        return;
      }
    }

    const letter = await persist({
      // The number is what they will look for in the list afterwards.
      success: thenIssue ? undefined : "Saved as a draft.",
      error: "That letter was not saved",
    });

    if (!letter) {
      setBusy(false);
      return;
    }

    if (thenIssue) {
      const issued = await mutate(
        () =>
          api(`/api/letters/${letter.id}`, {
            method: "POST",
            // The filled values go with the issue, not before it: two requests
            // can half-succeed, and a letter issued from values the second one
            // never wrote is the wrong document with the right reference.
            body: { action: "issue", filled },
          }),
        { success: `Issued as ${letter.letterNumber}.`, error: "That letter was not issued" },
      );
      setBusy(false);
      // Issuing failed, but the draft is saved and still open here, bound to
      // its number -- so it can be corrected and issued again, rather than
      // found later in the list with no way back into the editor.
      if (issued === null) {
        router.refresh();
        return;
      }
    } else {
      setBusy(false);
    }

    finish();
  }

  // Nobody to address a letter to. A form with an empty "For" and three
  // disabled buttons explained nothing; a new organisation's owner is not an
  // employee until somebody makes them one.
  if (employees.length === 0 && !extraEmployee) {
    return (
      <Alert tone="info" title="Add an employee first">
        A letter is issued to somebody on the employee list, and there is nobody on it yet.{" "}
        <Link href="/employees" className="underline underline-offset-2">
          Add an employee
        </Link>{" "}
        and come back.
      </Alert>
    );
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <FileSignature className="size-4" aria-hidden />
        New letter
      </Button>
    );
  }

  const ready = form.body.trim().length > 20 && form.subject.trim().length > 1 && form.employeeId;
  const reopened = bound?.reopened ?? false;
  const recipients = extraEmployee ? [extraEmployee, ...employees] : employees;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <FileSignature className="size-4 text-primary" aria-hidden />
            {bound ? `Draft ${bound.letterNumber}` : "New letter"}
          </span>
          <Button size="sm" variant="ghost" onClick={() => (reopened ? finish() : setOpen(false))}>
            <X className="size-4" aria-hidden />
          </Button>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          <Field
            label="For"
            htmlFor="letterEmployee"
            required
            hint={reopened ? "A draft stays with the person it was numbered for." : undefined}
          >
            <Select
              id="letterEmployee"
              value={form.employeeId}
              disabled={reopened}
              onChange={(e) => rebind({ employeeId: e.target.value })}
            >
              {recipients.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} ({e.code})
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Type" htmlFor="letterCategory" required>
            <Select
              id="letterCategory"
              value={form.category}
              disabled={reopened}
              onChange={(e) => {
                const value = e.target.value;
                const label = CATEGORIES.find((c) => c.value === value)?.label ?? "Letter";
                rebind({ category: value, subject: label });
              }}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Subject" htmlFor="letterSubject" required>
          <Input
            id="letterSubject"
            value={form.subject}
            onChange={(e) => set("subject", e.target.value)}
          />
        </Field>

        {/* ---------- AI drafting ---------- */}
        {aiAvailable ? (
          <div className="rounded-md border border-border p-3">
            <Field
              label="Ask the AI to draft it"
              htmlFor="aiPrompt"
              hint="It writes a template using placeholders. It never invents names, dates or salary figures — those come from the record."
            >
              <Textarea
                id="aiPrompt"
                rows={2}
                value={form.aiPrompt}
                placeholder="An experience certificate confirming her role and that her conduct was satisfactory."
                onChange={(e) => set("aiPrompt", e.target.value)}
              />
            </Field>
            <Button
              className="mt-2"
              size="sm"
              loading={drafting}
              disabled={form.aiPrompt.trim().length < 10}
              onClick={draft}
            >
              <Sparkles className="size-4" aria-hidden />
              Draft it
            </Button>
            {aiModel ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Drafted by {aiModel}. Read it before issuing — the AI is a drafting tool, not the
                authority on anyone&apos;s record.
              </p>
            ) : null}
          </div>
        ) : (
          <Alert tone="info" title="AI drafting is unavailable">
            Add an OpenRouter key in Settings → AI to draft letters from a description. You can
            still write one by hand.
          </Alert>
        )}

        {/* ---------- the template ---------- */}
        <Field
          label="Letter body"
          htmlFor="letterBody"
          required
          hint="Use {{placeholders}} for anything specific to the person."
        >
          <Textarea
            id="letterBody"
            rows={12}
            value={form.body}
            onChange={(e) => set("body", e.target.value)}
            onBlur={refreshPreview}
            className="font-mono text-xs"
          />
        </Field>

        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Placeholders you can use
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {placeholders.map((p) => (
              <button
                key={p.key}
                type="button"
                title={p.label}
                className="rounded border border-border px-1.5 py-0.5 font-mono hover:bg-muted"
                onClick={() => setForm((f) => ({ ...f, body: `${f.body}{{${p.key}}}` }))}
              >
                {p.key}
              </button>
            ))}
          </div>
        </details>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={refreshPreview}>
            <Eye className="size-4" aria-hidden />
            Refresh preview
          </Button>
          {/* The framework this letter type ships with, or the organisation's
              edit of it. Starting from a blank page every time is how two
              offer letters end up saying different things. */}
          <Button
            size="sm"
            variant="ghost"
            loading={loadingTemplate}
            disabled={loadingTemplate}
            onClick={() => void useTemplate()}
          >
            <FileText className="size-4" aria-hidden />
            Start from the template
          </Button>
        </div>

        {/* ---------- preview ---------- */}
        {preview ? (
          <div>
            <p className="mb-1.5 flex items-center gap-2 text-sm font-medium">
              How it will read
              {preview.canIssue ? (
                <Badge tone="success">Ready</Badge>
              ) : (
                <Badge tone="warning">{preview.problems.length} to fix</Badge>
              )}
            </p>
            <div className="whitespace-pre-wrap rounded-md border border-border bg-muted p-3 text-sm">
              {preview.text}
            </div>
            {preview.problems.filter((p) => p.kind === "UNKNOWN").length > 0 ? (
              <Alert tone="danger" title="Placeholders that do not exist">
                <ul className="list-inside list-disc">
                  {preview.problems
                    .filter((p) => p.kind === "UNKNOWN")
                    .map((p, i) => (
                      <li key={i}>{p.message}</li>
                    ))}
                </ul>
              </Alert>
            ) : null}

            {/* The fill-in form. Every placeholder the record cannot answer gets
                a box, so a letter needing a notice period or a reason is issued
                rather than being permanently stuck one value short. */}
            {/* Always shown, never a "problem" to be fixed. The signatory is
                not a gap in the record — it is a decision about this letter,
                and it prints on every one of them. It arrives filled in from
                the framework or the issuer's own profile; changing it here
                changes this letter and nothing else. */}
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-3 rounded-lg border border-border p-3 sm:grid-cols-2">
              <Field
                label="Signed by"
                htmlFor="fill-signatory-name"
                hint="From the letter type's setting, or your own profile."
              >
                <Input
                  id="fill-signatory-name"
                  value={filled["signatory.name"] ?? ""}
                  onChange={(e) =>
                    setFilled((f) => ({ ...f, "signatory.name": e.target.value }))
                  }
                  onBlur={refreshPreview}
                />
              </Field>
              <Field label="Their title" htmlFor="fill-signatory-title">
                <Input
                  id="fill-signatory-title"
                  value={filled["signatory.title"] ?? ""}
                  onChange={(e) =>
                    setFilled((f) => ({ ...f, "signatory.title": e.target.value }))
                  }
                  onBlur={refreshPreview}
                />
              </Field>
            </div>

            {preview.problems.filter((p) => p.kind === "MISSING" && !p.key.startsWith("signatory.")).length > 0 ? (
              <div className="mt-3 space-y-3 rounded-lg border border-dashed border-border p-3">
                <div>
                  <p className="text-sm font-medium">Fill these in</p>
                  <p className="text-xs text-muted-foreground">
                    Their record does not have a value for these. Type one and refresh the preview.
                  </p>
                </div>
                {preview.problems
                  .filter((p) => p.kind === "MISSING" && !p.key.startsWith("signatory."))
                  .map((problem) => {
                    const options = suggestions[problem.key] ?? [];
                    const value = filled[problem.key] ?? "";
                    // A list is offered only when the organisation has one and
                    // the author has not asked to type instead. Free text is
                    // always one click away: a letter occasionally has to say
                    // something the org chart does not contain, and a dropdown
                    // with no exit sends somebody to settings to create a
                    // department they do not want.
                    const picking =
                      options.length > 0 && !typing[problem.key] && (value === "" || options.includes(value));

                    return (
                      <Field
                        key={problem.key}
                        label={placeholders.find((p) => p.key === problem.key)?.label ?? problem.key}
                        htmlFor={`fill-${problem.key}`}
                      >
                        {picking ? (
                          <Select
                            id={`fill-${problem.key}`}
                            value={value}
                            onChange={(e) => {
                              if (e.target.value === CUSTOM) {
                                setTyping((t) => ({ ...t, [problem.key]: true }));
                                setFilled((f) => ({ ...f, [problem.key]: "" }));
                                return;
                              }
                              setFilled((f) => ({ ...f, [problem.key]: e.target.value }));
                            }}
                          >
                            <option value="">Choose one…</option>
                            {options.map((option) => (
                              <option key={option} value={option}>
                                {option}
                              </option>
                            ))}
                            <option value={CUSTOM}>Something else…</option>
                          </Select>
                        ) : (
                          <Input
                            id={`fill-${problem.key}`}
                            value={value}
                            onChange={(e) =>
                              setFilled((f) => ({ ...f, [problem.key]: e.target.value }))
                            }
                          />
                        )}
                      </Field>
                    );
                  })}
                <Button size="sm" variant="secondary" onClick={refreshPreview}>
                  <Eye className="size-4" aria-hidden />
                  Refresh with these
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={busy} disabled={!ready} onClick={() => save(false)}>
            <Save className="size-4" aria-hidden />
            {bound ? "Save the draft" : "Save as draft"}
          </Button>
          {/* Deliberately not gated on `canIssue`. Seeing the document is how
              somebody finds out that a value is missing, and refusing to show it
              until nothing is missing is the loop this button exists to break. */}
          <Button variant="outline" loading={busy} disabled={!ready} onClick={() => void previewPdf()}>
            <FileText className="size-4" aria-hidden />
            Preview the PDF
          </Button>
          <Button
            variant="success"
            loading={busy}
            disabled={!ready || (preview != null && !preview.canIssue)}
            onClick={() => save(true)}
          >
            <Send className="size-4" aria-hidden />
            Save &amp; issue
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
