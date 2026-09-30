"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
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
import { isValidCodePrefix, suggestCodePrefix } from "@/domain/employees/code";
import { CredentialHandover } from "@/components/auth/CredentialHandover";
import { MODULES } from "@/lib/features";

/**
 * Creating an organisation.
 *
 * The whole tenant is provisioned in one step — subscription, feature grants,
 * default shift, week-off, leave types and salary components — so nobody signs
 * in to an empty shell.
 */
export function CreateOrganization() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    name: string;
    email: string;
    temporaryPassword: string;
    signInUrl: string;
  } | null>(null);

  const [form, setForm] = useState({
    name: "",
    slug: "",
    employeeCodePrefix: "",
    legalName: "",
    email: "",
    city: "",
    industry: "",
    // `null`, not zero: blank means "the organisation decides" and zero means
    // "no seats", and the two are sent to the service as different things.
    seats: null as number | null,
    billingMode: "" as "" | "TRIAL" | "PAID" | "FREE_INTERNAL",
    billingCycle: "ANNUAL" as "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL",
    trialDays: 14,
    alreadyPaid: false,
    ownerName: "",
    ownerEmail: "",
  });

  const [granted, setGranted] = useState<Set<string>>(
    () => new Set(MODULES.filter((m) => m.defaultGranted).map((m) => m.key)),
  );

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /**
   * Derives the slug and the code prefix from the name, until the user edits
   * either by hand. Both are things somebody would otherwise have to invent
   * twice, and both are easier to correct than to think up.
   */
  function onNameChange(value: string) {
    setForm((f) => ({
      ...f,
      name: value,
      slug: f.slug === slugify(f.name) ? slugify(value) : f.slug,
      employeeCodePrefix:
        f.employeeCodePrefix === suggestedPrefixFor(f.name)
          ? suggestedPrefixFor(value)
          : f.employeeCodePrefix,
    }));
  }

  async function submit() {
    setBusy(true);
    const created = await mutate(
      () =>
        api<{ owner: { email: string; temporaryPassword: string; signInUrl: string } }>(
          "/api/platform/organizations",
          {
            method: "POST",
            body: {
              name: form.name.trim(),
              slug: form.slug.trim(),
              employeeCodePrefix: form.employeeCodePrefix.trim() || undefined,
              legalName: form.legalName.trim() || undefined,
              email: form.email.trim() || undefined,
              city: form.city.trim() || undefined,
              industry: form.industry.trim() || undefined,
              // Anything left blank is simply not sent, and the service treats
              // its absence as "the organisation's admin will set this".
              seats: form.seats ?? undefined,
              billingMode: form.billingMode || undefined,
              billingCycle: form.billingMode === "PAID" ? form.billingCycle : undefined,
              trialDays: form.billingMode === "TRIAL" ? form.trialDays : undefined,
              alreadyPaid: form.billingMode === "PAID" ? form.alreadyPaid : undefined,
              grantedModules: [...granted],
              owner: { name: form.ownerName.trim(), email: form.ownerEmail.trim() },
            },
          },
        ),
      { error: "Could not create the organisation" },
    );
    setBusy(false);
    if (created) {
      setOpen(false);
      setResult({ ...created.owner, name: form.name.trim() });
      router.refresh();
    }
  }

  /**
   * What still stands between the form and the Create button, in words.
   *
   * A disabled primary button with no reason beside it sent people back up
   * the form guessing, and the blank they had missed was three fields up.
   */
  const missing = [
    form.name.trim().length >= 2 ? null : "a name",
    form.slug.trim().length >= 3 ? null : "a slug of at least three characters",
    isValidCodePrefix(form.employeeCodePrefix) ? null : "a three- or four-letter employee code prefix",
    form.ownerName.trim().length >= 2 ? null : "the owner's name",
    /.+@.+\..+/.test(form.ownerEmail) ? null : "a valid owner email",
  ].filter((item): item is string => item !== null);
  const valid = missing.length === 0;

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        New organisation
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create an organisation</DialogTitle>
            <DialogDescription>
              Its owner account, subscription and defaults are set up in one go.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
              <Field label="Organisation name" htmlFor="name" required>
                <Input
                  id="name"
                  value={form.name}
                  onChange={(e) => onNameChange(e.target.value)}
                  placeholder="Acme Technologies"
                />
              </Field>
              <Field label="Slug" htmlFor="slug" required hint="Used in URLs. Lowercase, hyphens.">
                <Input
                  id="slug"
                  value={form.slug}
                  onChange={(e) => set("slug", slugify(e.target.value))}
                  placeholder="acme"
                  className="font-mono"
                />
              </Field>
              <Field
                label="Employee code prefix"
                htmlFor="employeeCodePrefix"
                required
                hint={
                  isValidCodePrefix(form.employeeCodePrefix)
                    ? `Their people will be ${form.employeeCodePrefix}001, ${form.employeeCodePrefix}002…`
                    : "Three or four letters. Every employee code here starts with them."
                }
              >
                {/* Four, like the domain and the profile box: the suggestion
                    itself is four letters for most names (JVNK, KMWL), and a
                    box capped at three could hold it but never let anybody
                    type it back. */}
                <Input
                  id="employeeCodePrefix"
                  value={form.employeeCodePrefix}
                  onChange={(e) =>
                    set("employeeCodePrefix", e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase())
                  }
                  maxLength={4}
                  spellCheck={false}
                  placeholder="ACM"
                  aria-invalid={form.employeeCodePrefix !== "" && !isValidCodePrefix(form.employeeCodePrefix)}
                  className="font-mono uppercase tracking-[0.2em]"
                />
              </Field>
              <Field label="Legal name" htmlFor="legalName">
                <Input
                  id="legalName"
                  value={form.legalName}
                  onChange={(e) => set("legalName", e.target.value)}
                  placeholder="Acme Technologies Private Limited"
                />
              </Field>
              <Field label="Contact email" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  placeholder="hr@acme.com"
                />
              </Field>
              <Field label="City" htmlFor="city">
                <Input id="city" value={form.city} onChange={(e) => set("city", e.target.value)} />
              </Field>
              <Field label="Industry" htmlFor="industry">
                <Input
                  id="industry"
                  value={form.industry}
                  onChange={(e) => set("industry", e.target.value)}
                  placeholder="Information Technology"
                />
              </Field>
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium">Commercials</p>
              <p className="mb-3 text-xs text-muted-foreground">
                Optional. Leave any of these blank and the organisation&rsquo;s own
                administrator settles it from their billing screen.
              </p>

              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-3">
                <Field
                  label="Employees"
                  htmlFor="seats"
                  hint="How many they may activate."
                >
                  <NumberField
                    id="seats"
                    min={0}
                    max={10_000}
                    placeholder="They decide"
                    value={form.seats}
                    onValueChange={(v) => set("seats", v)}
                    className="tabular"
                  />
                </Field>

                <Field label="Billing" htmlFor="billingMode">
                  <Select
                    id="billingMode"
                    value={form.billingMode}
                    onChange={(e) => set("billingMode", e.target.value as typeof form.billingMode)}
                  >
                    <option value="">They decide — starts as a trial</option>
                    <option value="TRIAL">Trial</option>
                    <option value="PAID">Paid</option>
                    <option value="FREE_INTERNAL">Free / internal</option>
                  </Select>
                </Field>

                {form.billingMode === "TRIAL" ? (
                  <Field label="Trial days" htmlFor="trialDays">
                    <NumberField
                      id="trialDays"
                      min={1}
                      max={365}
                      value={form.trialDays}
                      onValueChange={(v) => set("trialDays", v ?? 1)}
                      className="tabular"
                    />
                  </Field>
                ) : null}

                {form.billingMode === "PAID" ? (
                  <Field label="Renews" htmlFor="billingCycle">
                    <Select
                      id="billingCycle"
                      value={form.billingCycle}
                      onChange={(e) =>
                        set("billingCycle", e.target.value as typeof form.billingCycle)
                      }
                    >
                      <option value="MONTHLY">Monthly</option>
                      <option value="QUARTERLY">Quarterly</option>
                      <option value="HALF_YEARLY">Half-yearly</option>
                      <option value="ANNUAL">Annually</option>
                    </Select>
                  </Field>
                ) : null}
              </div>

              {form.billingMode === "PAID" ? (
                <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={form.alreadyPaid}
                    onChange={(e) => set("alreadyPaid", e.target.checked)}
                  />
                  <span>
                    Already paid
                    <span className="block text-xs text-muted-foreground">
                      Tick when the money has changed hands elsewhere. Left unticked, the
                      organisation is created read-only (sign-in and the billing page still
                      work) until a payment is approved.
                    </span>
                  </span>
                </label>
              ) : null}

              {form.seats === null ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  With no seats set, they can sign in and configure everything, but adding
                  their first employee will ask them to buy seats first.
                </p>
              ) : null}
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium">Owner account</p>
              <p className="mb-3 text-xs text-muted-foreground">
                They get a one-time password and must change it at first sign-in.
              </p>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="ownerName" required>
                  <Input
                    id="ownerName"
                    value={form.ownerName}
                    onChange={(e) => set("ownerName", e.target.value)}
                    placeholder="Rajesh Verma"
                  />
                </Field>
                <Field label="Email" htmlFor="ownerEmail" required>
                  <Input
                    id="ownerEmail"
                    type="email"
                    value={form.ownerEmail}
                    onChange={(e) => set("ownerEmail", e.target.value)}
                    placeholder="rajesh@acme.com"
                  />
                </Field>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-medium">Modules this organisation may use</p>
              <p className="mb-3 text-xs text-muted-foreground">
                Their own admin decides which of these to switch on.
              </p>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
                {MODULES.map((module) => (
                  <label
                    key={module.key}
                    className={`flex items-start gap-2 rounded-md border p-2 text-sm ${
                      module.core ? "border-border bg-muted/50" : "border-border"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4"
                      checked={module.core || granted.has(module.key)}
                      disabled={module.core}
                      onChange={(e) => {
                        setGranted((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(module.key);
                          else next.delete(module.key);
                          return next;
                        });
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">{module.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {module.core ? "Always on" : module.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!valid} onClick={submit}>
              <Building2 className="size-4" aria-hidden />
              Create organisation
            </Button>
            {valid ? null : (
              <p
                className="self-center text-xs text-muted-foreground sm:order-first sm:mr-auto"
                aria-live="polite"
              >
                Still needed: {missing.join(", ")}.
              </p>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The password is shown exactly once — it is stored only as a hash. */}
      <Dialog open={result !== null} onOpenChange={(open) => !open && setResult(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Organisation created</DialogTitle>
            <DialogDescription>Pass these details to the owner.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <CredentialHandover
              credential={{
                name: result?.name ?? "the owner",
                email: result?.email ?? "",
                temporaryPassword: result?.temporaryPassword ?? "",
                signInUrl: result?.signInUrl ?? "",
              }}
              title="Hand these to the owner"
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * The prefix a name suggests, and nothing for no name.
 *
 * `suggestCodePrefix("")` is the shipped default, `EMP`, while the box starts
 * blank -- so "is the box still showing the suggestion?" was false before the
 * first keystroke and the prefix never followed the name at all. The slug
 * never had this problem only because `slugify("")` happens to be `""`.
 */
function suggestedPrefixFor(name: string): string {
  return name.trim() === "" ? "" : suggestCodePrefix(name);
}
