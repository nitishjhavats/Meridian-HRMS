"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { isValidCodePrefix } from "@/domain/employees/code";
import { api, mutate } from "@/lib/client/api";
import {
  DOCUMENT_KINDS,
  DOCUMENT_LABELS,
  IDENTIFIERS as STATUTORY,
  type DocumentIdentifiers,
} from "@/domain/org/documentIdentifiers";

/**
 * The organisation's own details.
 *
 * The address here is the one that prints on every letter and payslip, and the
 * statutory identifiers are what an appointment letter has to quote. Neither
 * had anywhere to be entered before: the address came from whatever the
 * organisation was created with, and a CIN or GSTIN had no column at all.
 *
 * Nothing here is format-checked beyond length. These identifiers are issued by
 * several different authorities in formats that change, and refusing a
 * legitimate one because a regex is out of date is worse than storing a wrong
 * one somebody can see and correct.
 */

export interface Profile {
  name: string;
  /** The company seal, as a URL the browser can render. */
  stampUrl?: string | null;
  signatureUrl?: string | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
  employeeCodePrefix: string;
  trainingDays: number;
  showStatutoryOnDocuments: boolean;
  /** Which identifiers print on which document. */
  documentIdentifiers: DocumentIdentifiers;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  cin: string | null;
  gstin: string | null;
  panNumber: string | null;
  tan: string | null;
  pfCode: string | null;
  esiCode: string | null;
  probationDays: number;
}

type Key = keyof Profile;

/** The identifier *fields* on this form, which are not the same list as the
 * document matrix above: this one names Prisma columns, that one names keys. */
const IDENTIFIERS: { key: Key; label: string; hint: string }[] = [
  { key: "cin", label: "CIN", hint: "Corporate identity number" },
  { key: "gstin", label: "GSTIN", hint: "GST registration" },
  { key: "panNumber", label: "Company PAN", hint: "The organisation's PAN, not an employee's" },
  { key: "tan", label: "TAN", hint: "Tax deduction account number" },
  { key: "pfCode", label: "PF code", hint: "EPF establishment code" },
  { key: "esiCode", label: "ESI code", hint: "ESIC establishment code" },
];

export function OrganisationProfile({ initial }: { initial: Profile }) {
  const router = useRouter();
  // The two new text fields are nullable on the wire and never null in an
  // input: a controlled input given null is uncontrolled, and React will say so
  // once, in development, and then quietly lose keystrokes.
  const [form, setForm] = useState({
    ...initial,
    signatoryName: initial.signatoryName ?? "",
    signatoryTitle: initial.signatoryTitle ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [stampUrl, setStampUrl] = useState(initial.stampUrl ?? null);
  const [signatureUrl, setSignatureUrl] = useState(initial.signatureUrl ?? null);

  async function uploadStamp(file: File) {
    const body = new FormData();
    body.append("file", file);
    setBusy(true);
    const result = await mutate<{ stampUrl: string | null }>(
      () => api("/api/branding/stamp", { method: "POST", body }),
      { success: "Stamp saved.", error: "The stamp was not saved" },
    );
    setBusy(false);
    if (result) {
      setStampUrl(result.stampUrl);
      router.refresh();
    }
  }

  async function uploadSignature(file: File) {
    setBusy(true);
    const body = new FormData();
    body.set("file", file);
    const result = await mutate<{ signatureUrl: string | null }>(
      () => api("/api/branding/signature", { method: "POST", body }),
      { success: "Signature saved.", error: "The signature was not saved" },
    );
    setBusy(false);
    if (result) setSignatureUrl(result.signatureUrl);
  }

  async function removeSignature() {
    setBusy(true);
    const result = await mutate<{ signatureUrl: string | null }>(
      () => api("/api/branding/signature", { method: "DELETE" }),
      { success: "Signature removed.", error: "Nothing was removed" },
    );
    setBusy(false);
    if (result) setSignatureUrl(null);
  }

  async function removeStamp() {
    setBusy(true);
    const result = await mutate<{ stampUrl: string | null }>(
      () => api("/api/branding/stamp", { method: "DELETE" }),
      { success: "Stamp removed.", error: "Nothing was removed" },
    );
    setBusy(false);
    if (result) {
      setStampUrl(null);
      router.refresh();
    }
  }

  function set(key: Key, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // `Key` covers the text fields only; the boolean and the numbers have their
  // own controls, so this coerces rather than widening the input's type.
  const value = (key: Key) => {
    const v = form[key];
    return typeof v === "string" ? v : "";
  };

  async function save() {
    setBusy(true);
    const result = await mutate<{ profile: Profile }>(
      () => api("/api/settings/organisation", { method: "PATCH", body: form }),
      { success: "Saved.", error: "Nothing was saved" },
    );
    setBusy(false);
    if (result) {
      setForm({
        ...result.profile,
        signatoryName: result.profile.signatoryName ?? "",
        signatoryTitle: result.profile.signatoryTitle ?? "",
      });
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <Section title="Name and contact" description="How you are named and reached.">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="orgName" required hint="What people see in the app.">
            <Input id="orgName" value={form.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field
            label="Registered name"
            htmlFor="orgLegalName"
            hint="The legal entity, if it differs. Letters can quote it."
          >
            <Input
              id="orgLegalName"
              value={value("legalName")}
              onChange={(e) => set("legalName", e.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="orgEmail">
            <Input id="orgEmail" value={value("email")} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Phone" htmlFor="orgPhone">
            <Input id="orgPhone" value={value("phone")} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field label="Website" htmlFor="orgWebsite">
            <Input
              id="orgWebsite"
              value={value("website")}
              onChange={(e) => set("website", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Registered address"
        description="Printed at the top of every letter and on payslips."
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-4 sm:grid-cols-2">
          <Field label="Address line 1" htmlFor="orgAddr1">
            <Input
              id="orgAddr1"
              value={value("addressLine1")}
              onChange={(e) => set("addressLine1", e.target.value)}
            />
          </Field>
          <Field label="Address line 2" htmlFor="orgAddr2">
            <Input
              id="orgAddr2"
              value={value("addressLine2")}
              onChange={(e) => set("addressLine2", e.target.value)}
            />
          </Field>
          <Field label="City" htmlFor="orgCity">
            <Input id="orgCity" value={value("city")} onChange={(e) => set("city", e.target.value)} />
          </Field>
          <Field label="State" htmlFor="orgState">
            <Input id="orgState" value={value("state")} onChange={(e) => set("state", e.target.value)} />
          </Field>
          <Field label="Postal code" htmlFor="orgPostal">
            <Input
              id="orgPostal"
              value={value("postalCode")}
              onChange={(e) => set("postalCode", e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Employment defaults"
        description="What the employee form starts from. Every one can be changed per person."
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-4 sm:grid-cols-2">
          <Field
            label="Probation period"
            htmlFor="probationDays"
            hint="Days from joining. Used to suggest a confirmation date; 0 means nobody starts on probation."
          >
            <NumberField
              id="probationDays"
              min={0}
              max={730}
              className="tabular"
              value={form.probationDays}
              onValueChange={(v) => setForm((f) => ({ ...f, probationDays: v ?? 0 }))}
            />
          </Field>

          <Field
            label="Training period"
            htmlFor="trainingDays"
            hint="Days from joining, for somebody who starts in training rather than on probation. The two are different lengths, and the form fills in whichever applies."
          >
            <NumberField
              id="trainingDays"
              min={0}
              max={730}
              className="tabular"
              value={form.trainingDays}
              onValueChange={(v) => setForm((f) => ({ ...f, trainingDays: v ?? 0 }))}
            />
          </Field>

          <Field
            label="Company prefix"
            htmlFor="employeeCodePrefix"
            hint={
              isValidCodePrefix(form.employeeCodePrefix)
                ? // Every number the organisation issues, not only its employee
                  // codes -- so the example shows the family rather than one of
                  // them.
                  `${form.employeeCodePrefix.toUpperCase()}001 for people, ${form.employeeCodePrefix.toUpperCase()}/OFR/${new Date().getFullYear()}/0001 for letters, and the same on payslips and expense claims.`
                : "Three or four letters, A to Z."
            }
          >
            <Input
              id="employeeCodePrefix"
              maxLength={4}
              spellCheck={false}
              autoCapitalize="characters"
              className="w-24 font-mono uppercase tracking-[0.2em]"
              aria-invalid={!isValidCodePrefix(form.employeeCodePrefix)}
              value={form.employeeCodePrefix}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  employeeCodePrefix: e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase(),
                }))
              }
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Statutory identifiers"
        description="Quoted on offer and appointment letters. Leave blank what does not apply."
      >
        <div className="space-y-4 p-4">
          <Alert tone="info" title="Only where a letter asks for them">
            Nothing here is checked against any register — it is printed exactly as you type it,
            so a letter carries what you meant it to carry.
          </Alert>

          {/**
            * Per identifier, per document.
            *
            * One switch for all six across all three was wrong in both
            * directions: a payslip is a tax record and an employee needs the
            * PAN and the PF code on it, while an offer letter with both across
            * the top reads like a tax notice. A blank value still prints
            * nothing, so ticking one you have not filled in is harmless.
            */}
          <div className="rounded-lg border border-border p-3">
            <p className="text-sm font-medium">What prints on which document</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Added as a line under your address. Only the ones you have filled in are printed.
            </p>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[22rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="py-1.5 pr-2 font-medium">
                      <span className="sr-only">Identifier</span>
                    </th>
                    {DOCUMENT_KINDS.map((kind) => (
                      <th key={kind} scope="col" className="px-2 py-1.5 text-xs font-medium">
                        {DOCUMENT_LABELS[kind]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {STATUTORY.map((identifier) => (
                    <tr key={identifier.key} className="border-b border-border last:border-0">
                      <th scope="row" className="py-1.5 pr-2 text-left text-xs font-medium">
                        {identifier.label}
                      </th>
                      {DOCUMENT_KINDS.map((kind) => (
                        <td key={kind} className="px-2 py-1.5">
                          <Switch
                            checked={form.documentIdentifiers[kind].includes(identifier.key)}
                            disabled={busy}
                            aria-label={`${identifier.label} on ${DOCUMENT_LABELS[kind]}`}
                            onCheckedChange={(on) =>
                              setForm((f) => ({
                                ...f,
                                documentIdentifiers: {
                                  ...f.documentIdentifiers,
                                  [kind]: on
                                    ? [...f.documentIdentifiers[kind], identifier.key]
                                    : f.documentIdentifiers[kind].filter(
                                        (k) => k !== identifier.key,
                                      ),
                                },
                              }))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            {IDENTIFIERS.map((field) => (
              <Field key={field.key} label={field.label} htmlFor={field.key} hint={field.hint}>
                <Input
                  id={field.key}
                  className="font-mono text-sm"
                  value={value(field.key)}
                  onChange={(e) => set(field.key, e.target.value)}
                />
              </Field>
            ))}
          </div>
        </div>
      </Section>

      {/* Its own section, and not part of the form's Save, because it is a file
          rather than a field: it uploads the moment one is chosen and removes
          the moment Remove is pressed. Bundling it into Save would mean an
          image sitting in the browser waiting for a button. */}
      <Section
        title="Authorised signature"
        description="Printed on every letter this organisation issues. A letter type that is signed by somebody else can override it in the letter template editor."
      >
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            {signatureUrl ? (
              <img
                src={signatureUrl}
                alt="Authorised signature"
                className="h-16 w-40 rounded border border-border bg-white object-contain p-1"
              />
            ) : (
              <span className="text-sm text-muted-foreground">
                No signature uploaded — letters print the signatory&rsquo;s name with nothing
                above it.
              </span>
            )}
            <Input
              id="signatureFile"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              className="max-w-xs"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void uploadSignature(file);
              }}
            />
            {signatureUrl ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void removeSignature()}
              >
                Remove
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field label="Who signs" htmlFor="signatoryName" hint="Printed under the signature.">
              <Input
                id="signatoryName"
                value={form.signatoryName}
                placeholder="Vikram Nair"
                onChange={(e) => setForm({ ...form, signatoryName: e.target.value })}
              />
            </Field>
            <Field label="Their designation" htmlFor="signatoryTitle">
              <Input
                id="signatoryTitle"
                value={form.signatoryTitle}
                placeholder="Managing Director"
                onChange={(e) => setForm({ ...form, signatoryTitle: e.target.value })}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            A PNG with a transparent background, scanned on white paper. It is stored as one, so a
            signature keeps the page behind it rather than arriving in a grey box.
          </p>
        </div>
      </Section>

      <Section
        title="Company stamp"
        description="Optional. Printed beside the signature on every letter, which is what makes one look issued rather than typed."
      >
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            {stampUrl ? (
              <img
                src={stampUrl}
                alt="Company stamp"
                className="size-20 rounded border border-border bg-white object-contain p-1"
              />
            ) : (
              <span className="text-sm text-muted-foreground">No stamp uploaded.</span>
            )}
            <Input
              id="stampFile"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              className="max-w-xs"
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Cleared so choosing the same file twice still fires, which is
                // what happens straight after a failed upload.
                e.target.value = "";
                if (file) void uploadStamp(file);
              }}
            />
            {stampUrl ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void removeStamp()}>
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            A PNG with a transparent background sits best on the page — it is stored as one, so a
            round seal keeps its corners instead of arriving in a white box.
          </p>
        </div>
      </Section>

      <Button loading={busy} disabled={busy} onClick={() => void save()}>
        <Save className="size-4" aria-hidden />
        Save organisation details
      </Button>
    </div>
  );
}
