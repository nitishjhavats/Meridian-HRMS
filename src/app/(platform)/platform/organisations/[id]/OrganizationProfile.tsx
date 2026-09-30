"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { isValidCodePrefix } from "@/domain/employees/code";

/**
 * Every zone the runtime knows, India first. `supportedValuesOf` is in every
 * browser this product supports; the short list is for one that lacks it.
 */
const FALLBACK_ZONES = ["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];

/**
 * Read in the browser after mount, not at module scope: Node's list differs
 * from Chrome's (`Asia/Calcutta` for one), and a list built during server
 * rendering would not match the one the client renders.
 */
function browserZones(): string[] {
  const all =
    typeof Intl !== "undefined" && "supportedValuesOf" in Intl
      ? (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone")
      : FALLBACK_ZONES;
  return ["Asia/Kolkata", ...all.filter((z) => z !== "Asia/Kolkata")];
}

/**
 * The organisation's own details, editable after creation.
 *
 * `updateOrganization` has always accepted every column, but the route schema
 * stopped at eleven fields and the console only ever sent `{ seats }` -- so a
 * name typed wrong at creation, a missing address, or a GSTIN the customer
 * produced a week later could not be corrected anywhere. Letters and payslips
 * read exactly these fields, which is what made it worth fixing here rather
 * than asking the customer's own admin to do it.
 */

export interface OrganizationProfileValues {
  name: string;
  legalName: string;
  slug: string;
  email: string;
  phone: string;
  website: string;
  industry: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  cin: string;
  gstin: string;
  panNumber: string;
  tan: string;
  pfCode: string;
  esiCode: string;
  timezone: string;
  currency: string;
  probationDays: number;
  employeeCodePrefix: string;
}

const IDENTIFIERS: { key: keyof OrganizationProfileValues; label: string }[] = [
  { key: "cin", label: "CIN" },
  { key: "gstin", label: "GSTIN" },
  { key: "panNumber", label: "Company PAN" },
  { key: "tan", label: "TAN" },
  { key: "pfCode", label: "PF code" },
  { key: "esiCode", label: "ESI code" },
];

export function OrganizationProfile({
  organizationId,
  initial,
}: {
  organizationId: string;
  initial: OrganizationProfileValues;
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [zones, setZones] = useState<string[]>(FALLBACK_ZONES);
  useEffect(() => setZones(browserZones()), []);
  // Whatever is stored stays selectable, even a value this browser does not
  // list -- otherwise the box would show one zone while the state held
  // another, and saving any other field would be refused for a field that
  // looked right.
  const zoneOptions = zones.includes(form.timezone) ? zones : [form.timezone, ...zones];
  const [busy, setBusy] = useState(false);

  const set = (key: keyof OrganizationProfileValues) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const slugChanged = form.slug.trim().toLowerCase() !== initial.slug;
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const prefixOk = isValidCodePrefix(form.employeeCodePrefix);

  async function save() {
    setBusy(true);
    const done = await mutate(
      () =>
        api(`/api/platform/organizations/${organizationId}`, {
          method: "PATCH",
          body: {
            ...form,
            slug: form.slug.trim().toLowerCase(),
            probationDays: Number(form.probationDays) || 0,
          },
        }),
      { success: "Organisation updated.", error: "Nothing was saved" },
    );
    setBusy(false);
    if (done) router.refresh();
  }

  return (
    <Section
      title="Organisation details"
      description="What their letters and payslips print. Their own admin can edit most of this too."
    >
      <div className="space-y-5 p-4">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="org-name" required>
            <Input
              id="org-name"
              value={form.name}
              onChange={(e) => set("name")(e.target.value)}
            />
          </Field>
          <Field label="Registered name" htmlFor="org-legal" hint="If it differs from the above.">
            <Input
              id="org-legal"
              value={form.legalName}
              onChange={(e) => set("legalName")(e.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Sign-in address"
          htmlFor="org-slug"
          required
          hint={`Their door is hrms.broadmate.org/o/${form.slug.trim().toLowerCase() || "…"}`}
        >
          <Input
            id="org-slug"
            value={form.slug}
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => set("slug")(e.target.value)}
          />
        </Field>

        {/* Says what `organizationAtSlug` actually does. The old copy warned
            that the old address would stop working and every handout would
            need reissuing; it keeps resolving on purpose (bookmarks, printed
            links and installed apps all carry it), and the past-slug table
            keeps it from being handed to anybody else. */}
        {slugChanged ? (
          <Alert tone="warning" title="This changes the address they hand to their staff">
            The old one, <code>/o/{initial.slug}</code>, keeps working: anyone who bookmarked it,
            printed it or installed the app from it still arrives here, and no other organisation
            can ever be given it. Nothing already handed out needs reissuing &mdash; only new
            handouts and links should carry the new address.
          </Alert>
        ) : null}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          <Field label="Email" htmlFor="org-email">
            <Input
              id="org-email"
              type="email"
              value={form.email}
              onChange={(e) => set("email")(e.target.value)}
            />
          </Field>
          <Field label="Phone" htmlFor="org-phone">
            <Input
              id="org-phone"
              value={form.phone}
              onChange={(e) => set("phone")(e.target.value)}
            />
          </Field>
          <Field label="Website" htmlFor="org-website">
            <Input
              id="org-website"
              value={form.website}
              onChange={(e) => set("website")(e.target.value)}
            />
          </Field>
          <Field label="Industry" htmlFor="org-industry">
            <Input
              id="org-industry"
              value={form.industry}
              onChange={(e) => set("industry")(e.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Registered address
          </p>
          <Field label="Address line 1" htmlFor="org-addr1">
            <Input
              id="org-addr1"
              value={form.addressLine1}
              onChange={(e) => set("addressLine1")(e.target.value)}
            />
          </Field>
          <Field label="Address line 2" htmlFor="org-addr2">
            <Input
              id="org-addr2"
              value={form.addressLine2}
              onChange={(e) => set("addressLine2")(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="City" htmlFor="org-city">
              <Input
                id="org-city"
                value={form.city}
                onChange={(e) => set("city")(e.target.value)}
              />
            </Field>
            <Field label="State" htmlFor="org-state">
              <Input
                id="org-state"
                value={form.state}
                onChange={(e) => set("state")(e.target.value)}
              />
            </Field>
            <Field label="Postal code" htmlFor="org-postal">
              <Input
                id="org-postal"
                value={form.postalCode}
                onChange={(e) => set("postalCode")(e.target.value)}
              />
            </Field>
            <Field label="Country" htmlFor="org-country">
              <Input
                id="org-country"
                value={form.country}
                onChange={(e) => set("country")(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Statutory identifiers
          </p>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {IDENTIFIERS.map(({ key, label }) => (
              <Field key={key} label={label} htmlFor={`org-${key}`}>
                <Input
                  id={`org-${key}`}
                  className="font-mono text-sm"
                  value={String(form[key] ?? "")}
                  onChange={(e) => set(key)(e.target.value)}
                />
              </Field>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Nothing here is checked against any register. They appear on letters and payslips
            exactly as typed.
          </p>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/**
            * A list, not a box. A typo here ("Asia/Kolkatta", "IST") made
            * Intl throw on every screen of the organisation, for everybody in
            * it, and the platform owner saw "saved". The server refuses an
            * unknown zone too; this stops one being typed.
            */}
          <Field label="Timezone" htmlFor="org-tz">
            <Select
              id="org-tz"
              value={form.timezone}
              onChange={(e) => set("timezone")(e.target.value)}
            >
              {zoneOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" htmlFor="org-currency" hint="Three letters.">
            <Input
              id="org-currency"
              value={form.currency}
              maxLength={3}
              onChange={(e) => set("currency")(e.target.value.toUpperCase())}
            />
          </Field>
          {/**
            * Four letters, not three. The column and the domain have taken
            * four since JVNK and KMWL were chosen by hand, and a box capped at
            * three could not re-type either of them. And the refusal is now a
            * field error that holds the Save button, because the server's
            * answer to a two-letter prefix used to be a 500 -- the domain
            * throws a plain Error, which the route reported as "something
            * went wrong on our side" with a reference to quote.
            */}
          <Field
            label="Employee code prefix"
            htmlFor="org-prefix"
            error={prefixOk ? undefined : "Three or four letters, A to Z."}
            hint={`New employees get ${form.employeeCodePrefix.toUpperCase()}001 onwards.`}
          >
            <Input
              id="org-prefix"
              maxLength={4}
              spellCheck={false}
              className="font-mono uppercase tracking-[0.2em]"
              value={form.employeeCodePrefix}
              onChange={(e) =>
                set("employeeCodePrefix")(e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase())
              }
            />
          </Field>
          <Field
            label="Probation period"
            htmlFor="org-probation"
            hint="Days from joining. 0 means nobody starts on probation."
          >
            <Input
              id="org-probation"
              type="number"
              min={0}
              max={730}
              value={form.probationDays}
              onChange={(e) => set("probationDays")(e.target.value)}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button loading={busy} disabled={busy || !dirty || !prefixOk} onClick={() => void save()}>
            Save changes
          </Button>
          {dirty ? (
            <Button variant="ghost" disabled={busy} onClick={() => setForm(initial)}>
              Discard
            </Button>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
