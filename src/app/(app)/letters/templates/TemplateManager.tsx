"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, RotateCcw, Save, Sparkles, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import type { LetterValues } from "@/domain/letters/template";
import { frameworkChanged, renderFrameworkPreview } from "./framework";

/**
 * Editing the framework a letter type is issued from.
 *
 * Three parts, edited separately because that is how somebody thinks about them
 * — "put our GST number in the header" is a different job from rewriting the
 * body. Each has an AI box beside it that changes only that part, and the
 * result lands in the editor rather than being saved: a letter framework is a
 * legal document for everybody it will ever be issued to, so saving stays a
 * deliberate act with a preview in between.
 *
 * The preview is rendered against a real employee, because that is the only way
 * to see whether a placeholder actually resolves. Without one it shows the
 * labels, which is still useful before anybody has been hired.
 *
 * It is rendered here, from the text in the boxes: the server supplies the
 * values it resolved for that employee, and the editor fills its own draft
 * with them. Asking the server for the rendered text showed the *saved*
 * framework, so an edit did not appear in the preview until after it was
 * saved -- the one order of events the preview exists to prevent.
 */

interface Framework {
  category: string;
  label: string;
  subject: string;
  header: string;
  body: string;
  footer: string;
  customised: boolean;
  frozenCopyOfDefault: boolean;
  showLogo: boolean;
  showSignature: boolean;
  showStamp: boolean;
  signatory: {
    name: string | null;
    title: string | null;
    imageUrl: string | null;
    /** True when it comes from the organisation rather than this letter type. */
    inherited: boolean;
  };
  placeholders: string[];
  updatedAt: string | null;
}

interface Placeholder {
  key: string;
  label: string;
  hint: string;
}

type Part = "header" | "body" | "footer";

export function TemplateManager({
  initial,
  employees,
  placeholders,
  canWrite,
  aiAvailable,
  canSeePayslip,
}: {
  initial: Framework[];
  employees: { id: string; name: string; employeeCode: string }[];
  placeholders: Placeholder[];
  canWrite: boolean;
  aiAvailable: boolean;
  canSeePayslip: boolean;
}) {
  const router = useRouter();
  const [frameworks, setFrameworks] = useState(initial);
  const [category, setCategory] = useState(initial[0]?.category ?? "OFFER");
  const [draft, setDraft] = useState<Framework | null>(initial[0] ?? null);
  const [employeeId, setEmployeeId] = useState("");
  /**
   * What the chosen employee's placeholders resolve to, as the server last
   * answered. Null until somebody asks; the preview itself is derived from
   * these and the draft, so it follows every keystroke without another call.
   */
  const [values, setValues] = useState<LetterValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [aiPart, setAiPart] = useState<Part | null>(null);
  const [instruction, setInstruction] = useState("");

  const current = useMemo(
    () => frameworks.find((f) => f.category === category) ?? null,
    [frameworks, category],
  );

  // Every field Save would write, not only the four text boxes. A signatory
  // typed in or a switch flipped with the wording untouched left this false,
  // Save greyed out, and the edit lost on the next navigation.
  const dirty = draft !== null && current !== null && frameworkChanged(draft, current);

  const preview = useMemo(
    () => (draft && values ? renderFrameworkPreview(draft, values) : null),
    [draft, values],
  );

  function choose(next: string) {
    setCategory(next);
    setDraft(frameworks.find((f) => f.category === next) ?? null);
    // The letter number and the fallback signatory are per type, so the
    // values fetched for one do not describe another.
    setValues(null);
    setAiPart(null);
  }

  function set(part: Part | "subject", value: string) {
    setDraft((d) => (d ? { ...d, [part]: value } : d));
  }

  async function runPreview() {
    if (!draft) return;
    setBusy(true);
    // Through `mutate` for its error toast. A swallowed failure here showed
    // nothing at all, and nothing is indistinguishable from "still loading".
    const result = await mutate(
      () =>
        api<{ values: LetterValues }>(`/api/letters/templates/${draft.category}/preview`, {
          method: "POST",
          body: { employeeId: employeeId || undefined },
        }),
      { success: undefined, error: "The preview could not be rendered" },
    );
    setBusy(false);
    if (result) setValues(result.values);
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    const result = await mutate<{ framework: Framework }>(
      () =>
        api(`/api/letters/templates/${draft.category}`, {
          method: "PUT",
          body: {
            subject: draft.subject,
            header: draft.header,
            body: draft.body,
            footer: draft.footer,
            showLogo: draft.showLogo,
            showSignature: draft.showSignature,
            showStamp: draft.showStamp,
            signatoryName: draft.signatory.name?.trim() || null,
            signatoryTitle: draft.signatory.title?.trim() || null,
          },
        }),
      { success: `${draft.label} saved.`, error: "Nothing was saved" },
    );
    setBusy(false);
    if (result) {
      setFrameworks((all) =>
        all.map((f) => (f.category === result.framework.category ? result.framework : f)),
      );
      setDraft(result.framework);
      router.refresh();
    }
  }

  /**
   * The signature image, uploaded on its own.
   *
   * Separate from `save()` because the endpoint takes multipart rather than
   * JSON, and because the two acts should be able to fail independently: a
   * rejected image must not throw away wording somebody has just rewritten.
   * Both calls return the whole framework back, so the editor never has to
   * guess what the server now holds.
   */
  async function uploadSignature(file: File) {
    if (!draft) return;
    const form = new FormData();
    form.append("file", file);
    setBusy(true);
    const result = await mutate<{ framework: Framework }>(
      () =>
        api(`/api/letters/templates/${draft.category}/signature`, {
          method: "POST",
          body: form,
        }),
      { success: "Signature saved.", error: "The signature was not saved" },
    );
    setBusy(false);
    if (result) applyFramework(result.framework);
  }

  async function removeSignature() {
    if (!draft) return;
    setBusy(true);
    const result = await mutate<{ framework: Framework }>(
      () =>
        api(`/api/letters/templates/${draft.category}/signature`, { method: "DELETE" }),
      { success: "Signature removed.", error: "Nothing was removed" },
    );
    setBusy(false);
    if (result) applyFramework(result.framework);
  }

  /** One place that reconciles a server answer with what is on screen. */
  function applyFramework(framework: Framework) {
    setFrameworks((all) => all.map((f) => (f.category === framework.category ? framework : f)));
    setDraft(framework);
    router.refresh();
  }

  async function restore() {
    if (!draft) return;
    setBusy(true);
    const result = await mutate<{ framework: Framework }>(
      () => api(`/api/letters/templates/${draft.category}`, { method: "DELETE" }),
      { success: "Back to the built-in version.", error: "Nothing was changed" },
    );
    setBusy(false);
    if (result) {
      setFrameworks((all) =>
        all.map((f) => (f.category === result.framework.category ? result.framework : f)),
      );
      setDraft(result.framework);
      // The row is gone, so the signatory falls back to the organisation's.
      setValues(null);
      router.refresh();
    }
  }

  async function customise() {
    if (!draft || !aiPart) return;
    setBusy(true);
    const result = await mutate<{ text: string; unknownPlaceholders: string[] }>(
      () =>
        api(`/api/letters/templates/${draft.category}/customise`, {
          method: "POST",
          body: { part: aiPart, current: draft[aiPart], instruction: instruction.trim() },
        }),
      { success: "Have a look before you save it.", error: "That change was not made" },
    );
    setBusy(false);
    if (result) {
      set(aiPart, result.text);
      setInstruction("");
      setAiPart(null);
    }
  }

  if (!draft || !current) return null;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
      <div className="space-y-4">
        <Section title="Letter type" description="Each one has its own framework.">
          <div className="space-y-3 p-4">
            <Select
              aria-label="Letter type"
              value={category}
              onChange={(e) => choose(e.target.value)}
            >
              {frameworks.map((f) => (
                <option key={f.category} value={f.category}>
                  {f.label}
                  {f.customised ? " — edited" : ""}
                </option>
              ))}
            </Select>

            <p className="text-xs text-muted-foreground">
              {current.customised
                ? "This is your organisation's version. Restore to go back to the one the product ships."
                : "This is the version the product ships. Saving any change makes it yours."}
            </p>

            {/**
              * They did not write this, and it is out of date.
              *
              * Uploading a signature used to copy the built-in text into a
              * saved row, because the row could not exist without it -- which
              * quietly made the organisation the owner of wording it had never
              * chosen, and froze it against every later improvement. This says
              * so, in the one place somebody can act on it.
              */}
            {current.frozenCopyOfDefault ? (
              <Alert tone="warning" title="This copy is out of date">
                These words are an older version of the one the product ships, saved automatically
                when a signature was uploaded &mdash; not something anybody here wrote. Restoring
                puts this letter back on the current wording, and keeps your signature.
              </Alert>
            ) : null}

            <Field label="Subject" htmlFor="subject" required>
              <Input
                id="subject"
                value={draft.subject}
                disabled={!canWrite}
                onChange={(e) => set("subject", e.target.value)}
              />
            </Field>

            {/* The signatory was a column, an API field and a service write with
                no input anywhere, so `signatory.title` was null on every letter
                ever issued -- and "Signatory title" therefore appeared in
                "Fill these in" every single time, for every employee. */}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <Field
                label="Signed by"
                htmlFor="signatoryName"
                hint="Leave blank to use whoever issues the letter."
              >
                <Input
                  id="signatoryName"
                  value={draft.signatory.name ?? ""}
                  disabled={!canWrite}
                  placeholder="Priya Sharma"
                  onChange={(e) =>
                    setDraft((d) =>
                      d ? { ...d, signatory: { ...d.signatory, name: e.target.value } } : d,
                    )
                  }
                />
              </Field>
              <Field
                label="Their title"
                htmlFor="signatoryTitle"
                hint="Blank falls back to their designation."
              >
                <Input
                  id="signatoryTitle"
                  value={draft.signatory.title ?? ""}
                  disabled={!canWrite}
                  placeholder="Head of People"
                  onChange={(e) =>
                    setDraft((d) =>
                      d ? { ...d, signatory: { ...d.signatory, title: e.target.value } } : d,
                    )
                  }
                />
              </Field>
            </div>

            {/* Both were unconditional: the signature appeared whenever this row
                had one and the stamp whenever the organisation had one, with
                nothing anywhere able to say "not on this letter". A salary
                certificate wants both; an internal memo often wants neither. */}
            <div className="space-y-2 rounded-lg border border-border p-3">
              <label className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Sign this letter</span>
                  <span className="block text-xs text-muted-foreground">
                    Prints the signature above the name.
                  </span>
                </span>
                <Switch
                  checked={draft.showSignature}
                  disabled={!canWrite}
                  aria-label="Sign this letter"
                  onCheckedChange={(showSignature) =>
                    setDraft((d) => (d ? { ...d, showSignature } : d))
                  }
                />
              </label>
              <label className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Stamp this letter</span>
                  <span className="block text-xs text-muted-foreground">
                    Prints the company seal beside the signature.
                  </span>
                </span>
                <Switch
                  checked={draft.showStamp}
                  disabled={!canWrite}
                  aria-label="Stamp this letter"
                  onCheckedChange={(showStamp) => setDraft((d) => (d ? { ...d, showStamp } : d))}
                />
              </label>
            </div>

            {/* The image `signatureKey` was always for. The column, the storage
                kind and the renderer have existed since the first migration;
                nothing had ever written it, so every letter this product has
                ever issued was signed with a typed name over a blank space. */}
            <Field
              label="Signature image"
              htmlFor="signatureFile"
              hint="A scan of the signature, on white or transparent. It prints above the name. Leave it empty to use the organisation's, set under Settings \u2192 Organisation."
            >
              <div className="flex flex-wrap items-center gap-3">
                {draft.signatory.imageUrl ? (
                  <img
                    src={draft.signatory.imageUrl}
                    alt={`Signature for ${draft.label}`}
                    className="h-12 w-auto max-w-[180px] rounded border border-border bg-white object-contain p-1"
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">None yet.</span>
                )}
                {canWrite ? (
                  <>
                    <Input
                      id="signatureFile"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={busy}
                      className="max-w-xs"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        // Cleared so choosing the same file twice still fires,
                        // which is what happens after a failed upload.
                        e.target.value = "";
                        if (file) void uploadSignature(file);
                      }}
                    />
                    {draft.signatory.imageUrl ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void removeSignature()}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </Field>
          </div>
        </Section>

        {(["header", "body", "footer"] as const).map((part) => (
          <Section
            key={part}
            title={part === "header" ? "Header" : part === "body" ? "Body" : "Footer"}
            description={
              part === "header"
                ? "Lines under your name and address — a confidentiality marking, a CIN, “to whomsoever it may concern”."
                : part === "body"
                  ? "The letter itself. Blank lines separate paragraphs."
                  : "One line along the bottom of every page."
            }
            action={
              aiAvailable && canWrite ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setAiPart(aiPart === part ? null : part);
                    setInstruction("");
                  }}
                >
                  <Sparkles className="size-4" aria-hidden />
                  Ask AI
                </Button>
              ) : null
            }
          >
            <div className="space-y-3 p-4">
              <Textarea
                aria-label={part}
                rows={part === "body" ? 16 : 3}
                className="font-mono text-xs"
                value={draft[part]}
                disabled={!canWrite}
                onChange={(e) => set(part, e.target.value)}
              />

              {aiPart === part ? (
                <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
                  <Field
                    label="What would you like changed?"
                    htmlFor={`ai-${part}`}
                    hint="It edits only this part, and nothing is saved until you press Save."
                  >
                    <Input
                      id={`ai-${part}`}
                      value={instruction}
                      placeholder={
                        part === "header"
                          ? "Add our GST number and registered office"
                          : part === "body"
                            ? "Mention the six-month probation period"
                            : "Add our website"
                      }
                      onChange={(e) => setInstruction(e.target.value)}
                    />
                  </Field>
                  <Button
                    size="sm"
                    loading={busy}
                    disabled={busy || instruction.trim().length < 4}
                    onClick={() => void customise()}
                  >
                    <Wand2 className="size-4" aria-hidden />
                    Rewrite the {part}
                  </Button>
                </div>
              ) : null}
            </div>
          </Section>
        ))}

        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} disabled={busy || !dirty} onClick={() => void save()}>
              <Save className="size-4" aria-hidden />
              Save {current.label.toLowerCase()}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void runPreview()}>
              <Eye className="size-4" aria-hidden />
              Preview
            </Button>
            {current.customised ? (
              <Button variant="ghost" disabled={busy} onClick={() => void restore()}>
                <RotateCcw className="size-4" aria-hidden />
                Restore the original
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="space-y-4 lg:sticky lg:top-4">
        <Section
          title="Preview"
          description="What it looks like filled in. It follows the editor as you type, before anything is saved."
        >
          <div className="space-y-3 p-4">
            <Field label="For whom" htmlFor="previewEmployee" hint="Leave blank to see the labels.">
              <Select
                id="previewEmployee"
                value={employeeId}
                onChange={(e) => {
                  setEmployeeId(e.target.value);
                  setValues(null);
                }}
              >
                <option value="">Nobody in particular</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} ({e.employeeCode})
                  </option>
                ))}
              </Select>
            </Field>

            <Button size="sm" variant="secondary" loading={busy} onClick={() => void runPreview()}>
              <Eye className="size-4" aria-hidden />
              {preview ? "Refresh" : "Show me"}
            </Button>

            {preview ? (
              <>
                {[...preview.header.problems, ...preview.body.problems, ...preview.footer.problems]
                  .length > 0 ? (
                  <Alert tone="warning" title="Some values are missing">
                    {[
                      ...preview.header.problems,
                      ...preview.body.problems,
                      ...preview.footer.problems,
                    ]
                      .map((p) => p.message)
                      .join(" ")}{" "}
                    A letter cannot be issued until every one of them has a value — fill them in on
                    the letter itself, or complete the record.
                  </Alert>
                ) : null}

                <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
                  {preview.header.text.trim() ? (
                    <p className="whitespace-pre-line text-xs text-muted-foreground">
                      {preview.header.text}
                    </p>
                  ) : null}
                  <p className="font-semibold">{preview.subject}</p>
                  <p className="whitespace-pre-line leading-relaxed">{preview.body.text}</p>
                  {preview.footer.text.trim() ? (
                    <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
                      {preview.footer.text}
                    </p>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </Section>

        {canSeePayslip ? (
          <Section
            title="Payslip"
            description="Not a template — the figures are calculated — but it is a document you send out, so it belongs here."
          >
            <div className="space-y-2 p-4">
              <p className="text-xs text-muted-foreground">
                Its header carries your name, address and logo, all of which are edited in
                organisation settings. Open a sample to see how they look on the page.
              </p>
              <Button asChild size="sm" variant="secondary">
                <a href="/api/payroll/slips/preview" target="_blank" rel="noreferrer noopener">
                  <Eye className="size-4" aria-hidden />
                  Open a sample payslip
                </a>
              </Button>
            </div>
          </Section>
        ) : null}

        <Section
          title="Placeholders"
          description="Anything in double braces is filled from the record when the letter is issued."
        >
          <ul className="max-h-80 divide-y divide-border overflow-auto">
            {placeholders.map((p) => (
              <li key={p.key} className="flex items-start gap-2 px-3 py-2">
                <Badge tone="neutral" className="shrink-0 font-mono text-[10px]">
                  {`{{${p.key}}}`}
                </Badge>
                <span className="min-w-0 text-xs text-muted-foreground">{p.hint}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}
