"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { api, mutate } from "@/lib/client/api";
import { formatMoney } from "@/lib/utils";

/**
 * Platform settings.
 *
 * Pricing, the UPI destination and the confirmation window are data, not code —
 * this form is what makes "₹59 per user" a number the owner can change rather
 * than a constant somebody has to deploy.
 */
export function SettingsForm({
  settings,
}: {
  settings: {
    pricePerUserPaise: number;
    paymentUpiId: string;
    paymentPayeeName: string;
    invoicePrefix: string;
    paymentWindowMinutes: number;
    confirmationMode: string;
    otpTtlMinutes: number;
    defaultTrialDays: number;
    seatGraceDays: number;
    selfieRetentionDays: number;
    defaultAiModel: string;
    selfSignupEnabled: boolean;
  };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    priceRupees: settings.pricePerUserPaise / 100,
    paymentUpiId: settings.paymentUpiId,
    paymentPayeeName: settings.paymentPayeeName,
    invoicePrefix: settings.invoicePrefix,
    paymentWindowMinutes: settings.paymentWindowMinutes,
    confirmationMode: settings.confirmationMode,
    otpTtlMinutes: settings.otpTtlMinutes,
    defaultTrialDays: settings.defaultTrialDays,
    seatGraceDays: settings.seatGraceDays,
    selfieRetentionDays: settings.selfieRetentionDays,
    defaultAiModel: settings.defaultAiModel,
    selfSignupEnabled: settings.selfSignupEnabled,
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setBusy(true);
    const result = await mutate(
      () =>
        api("/api/platform/settings", {
          method: "PATCH",
          body: {
            pricePerUserPaise: Math.round(form.priceRupees * 100),
            paymentUpiId: form.paymentUpiId.trim(),
            paymentPayeeName: form.paymentPayeeName.trim(),
            invoicePrefix: form.invoicePrefix.trim().toUpperCase(),
            paymentWindowMinutes: form.paymentWindowMinutes,
            confirmationMode: form.confirmationMode,
            otpTtlMinutes: form.otpTtlMinutes,
            defaultTrialDays: form.defaultTrialDays,
            seatGraceDays: form.seatGraceDays,
            selfieRetentionDays: form.selfieRetentionDays,
            defaultAiModel: form.defaultAiModel.trim(),
            selfSignupEnabled: form.selfSignupEnabled,
          },
        }),
      { success: "Platform settings saved." },
    );
    setBusy(false);
    if (result) router.refresh();
  }

  const pricePaise = Math.round(form.priceRupees * 100);

  return (
    <div className="space-y-6 p-4">
      {/* ---------- pricing ---------- */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Pricing</h3>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <Field
            label="Price per user per month (₹)"
            htmlFor="price"
            hint="Applies to new orders only. Orders already raised keep the price they were quoted."
          >
            <NumberField
              id="price"
              min={0}
              decimals={2}
              value={form.priceRupees}
              onValueChange={(v) => set("priceRupees", v ?? 0)}
              className="tabular"
            />
          </Field>
          <div className="rounded-lg bg-muted p-3 text-sm">
            <p className="text-xs text-muted-foreground">At this price</p>
            <ul className="mt-1 space-y-0.5">
              <li className="flex justify-between">
                <span>10 users</span>
                <span className="tabular">{formatMoney(pricePaise * 10)}</span>
              </li>
              <li className="flex justify-between">
                <span>50 users</span>
                <span className="tabular">{formatMoney(pricePaise * 50)}</span>
              </li>
              <li className="flex justify-between">
                <span>100 users</span>
                <span className="tabular">{formatMoney(pricePaise * 100)}</span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---------- payment ---------- */}
      <section className="space-y-4 border-t border-border pt-5">
        <h3 className="text-sm font-semibold">Payment collection</h3>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <Field label="UPI ID" htmlFor="upi" required hint="Where organisations send money.">
            <Input
              id="upi"
              value={form.paymentUpiId}
              onChange={(e) => set("paymentUpiId", e.target.value)}
              className="font-mono"
              placeholder="name@bank"
            />
          </Field>
          <Field label="Payee name" htmlFor="payee">
            <Input
              id="payee"
              value={form.paymentPayeeName}
              onChange={(e) => set("paymentPayeeName", e.target.value)}
            />
          </Field>
          {/* The platform's own mark, on the invoices it issues. An
              organisation's prefix answers "whose employee is this"; this one
              answers "who issued this". */}
          <Field
            label="Invoice prefix"
            htmlFor="invoicePrefix"
            hint={`Invoices are numbered ${
              form.invoicePrefix.trim().toUpperCase() || "BMG"
            }-${new Date().getFullYear()}-0001. Three or four letters, or blank to go back to BMG; the series carries on across a change.`}
          >
            <Input
              id="invoicePrefix"
              maxLength={4}
              spellCheck={false}
              autoCapitalize="characters"
              className="w-24 font-mono uppercase tracking-[0.2em]"
              value={form.invoicePrefix}
              onChange={(e) =>
                set("invoicePrefix", e.target.value.replace(/[^A-Za-z]/g, "").toUpperCase())
              }
            />
          </Field>
          <Field
            label="Confirmation window (minutes)"
            htmlFor="window"
            hint="240 = the 4 hours in the spec. Existing orders keep the window they were created with."
          >
            <NumberField
              id="window"
              min={15}
              max={10080}
              value={form.paymentWindowMinutes}
              onValueChange={(v) => set("paymentWindowMinutes", v ?? 15)}
              className="tabular"
            />
          </Field>
          <Field
            label="Confirmation method"
            htmlFor="confirmationMode"
            hint="How an organisation proves it has paid."
          >
            <Select
              id="confirmationMode"
              value={form.confirmationMode}
              onChange={(e) => set("confirmationMode", e.target.value)}
            >
              <option value="BOTH">Either — reference or a code you issue</option>
              <option value="UTR">They submit their UPI reference</option>
              <option value="CODE">You issue them a confirmation code</option>
            </Select>
          </Field>
        </div>
      </section>

      {/* ---------- subscriptions ---------- */}
      <section className="space-y-4 border-t border-border pt-5">
        <h3 className="text-sm font-semibold">Subscriptions</h3>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <Field label="Default trial length (days)" htmlFor="trialDays">
            <NumberField
              id="trialDays"
              min={1}
              max={365}
              value={form.defaultTrialDays}
              onValueChange={(v) => set("defaultTrialDays", v ?? 1)}
              className="tabular"
            />
          </Field>
          <Field
            label="Seat overage grace (days)"
            htmlFor="graceDays"
            hint="0 blocks new activations the moment seats run out."
          >
            <NumberField
              id="graceDays"
              min={0}
              max={90}
              value={form.seatGraceDays}
              onValueChange={(v) => set("seatGraceDays", v ?? 0)}
              className="tabular"
            />
          </Field>
        </div>

        {/*
          Enforced in three places already — the signup page, the signup route
          and `signUp()` — but until now there was no way to change it without
          editing the database by hand. On a public URL this is the switch that
          decides whether strangers can create organisations on your instance.
        */}
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Public sign-up</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {form.selfSignupEnabled
                ? "Anyone can create an organisation from the sign-up page."
                : "The sign-up page explains that new organisations are set up by invitation."}
            </p>
          </div>
          <Switch
            checked={form.selfSignupEnabled}
            onCheckedChange={(v) => set("selfSignupEnabled", v)}
            aria-label="Public sign-up enabled"
          />
        </div>
      </section>

      {/* ---------- security & privacy ---------- */}
      <section className="space-y-4 border-t border-border pt-5">
        <h3 className="text-sm font-semibold">Security & privacy</h3>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <Field
            label="Reset code lifetime (minutes)"
            htmlFor="otpTtl"
            hint="How long a released code stays usable."
          >
            <NumberField
              id="otpTtl"
              min={5}
              max={120}
              value={form.otpTtlMinutes}
              onValueChange={(v) => set("otpTtlMinutes", v ?? 5)}
              className="tabular"
            />
          </Field>
          <Field
            label="Attendance selfie retention (days)"
            htmlFor="retention"
            hint="Photos are deleted after this; the timestamp, location and match score are kept."
          >
            <NumberField
              id="retention"
              min={1}
              max={3650}
              value={form.selfieRetentionDays}
              onValueChange={(v) => set("selfieRetentionDays", v ?? 1)}
              className="tabular"
            />
          </Field>
        </div>
      </section>

      {/* ---------- AI ---------- */}
      <section className="space-y-4 border-t border-border pt-5">
        <h3 className="text-sm font-semibold">AI</h3>
        <Field
          label="Default model"
          htmlFor="aiModel"
          hint="Used when an organisation has not configured its own. Organisations can supply their own OpenRouter key."
        >
          <Input
            id="aiModel"
            value={form.defaultAiModel}
            onChange={(e) => set("defaultAiModel", e.target.value)}
            className="font-mono"
          />
        </Field>
        <Alert tone="info">
          If the provider rejects this model id, the app surfaces the provider&apos;s own error and
          lets an admin pick from the live model list rather than failing silently.
        </Alert>
      </section>

      <div className="flex justify-end border-t border-border pt-4">
        <Button loading={busy} onClick={save}>
          <Save className="size-4" aria-hidden />
          Save settings
        </Button>
      </div>
    </div>
  );
}
