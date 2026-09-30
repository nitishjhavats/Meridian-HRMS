"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Power, TicketPercent, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { NumberField } from "@/components/ui/number-field";
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
import { formatMoney } from "@/lib/utils";

/** Creating a discount coupon. The preview shows what a buyer would actually pay. */
export function CreateCoupon({
  pricePerUserPaise,
  organisations,
}: {
  pricePerUserPaise: number;
  /** For tying a coupon to one buyer. Empty is fine; the field just hides. */
  organisations: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const today = new Date();
  const inThirtyDays = new Date(today.getTime() + 30 * 86_400_000);

  // The four limits are `number | null` because blank is a real answer on each
  // of them — no ceiling, unlimited uses, any order size — and the server
  // stores that as null rather than as a zero.
  const [form, setForm] = useState({
    code: "",
    description: "",
    percent: 10,
    maxDiscountRupees: null as number | null,
    startsAt: today.toISOString().slice(0, 10),
    expiresAt: inThirtyDays.toISOString().slice(0, 10),
    maxRedemptions: null as number | null,
    maxPerOrganisation: null as number | null,
    minUserCount: null as number | null,
    maxUserCount: null as number | null,
    firstPurchaseOnly: false,
    listed: false,
    appliesToOrgId: "",
    active: true,
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const sampleSeats = form.minUserCount || 10;
  const sampleSubtotal = sampleSeats * pricePerUserPaise;
  const rawDiscount = Math.round((sampleSubtotal * form.percent) / 100);
  // Rounded on the way to paise: `× 100` on a raw float sent a ₹2000.55 cap as
  // 200054.99999999997 paise, which is not an amount of money.
  const cap = form.maxDiscountRupees ? Math.round(form.maxDiscountRupees * 100) : null;
  const sampleDiscount = cap != null ? Math.min(rawDiscount, cap) : rawDiscount;

  async function submit() {
    setBusy(true);
    const result = await mutate(
      () =>
        api("/api/platform/coupons", {
          method: "POST",
          body: {
            code: form.code.trim() || undefined,
            description: form.description.trim() || undefined,
            percent: form.percent,
            maxDiscountPaise: cap,
            startsAt: new Date(`${form.startsAt}T00:00:00`),
            expiresAt: new Date(`${form.expiresAt}T23:59:59`),
            maxRedemptions: form.maxRedemptions,
            maxPerOrganisation: form.maxPerOrganisation,
            minUserCount: form.minUserCount,
            maxUserCount: form.maxUserCount,
            firstPurchaseOnly: form.firstPurchaseOnly,
            listed: form.listed,
            // "" is the "any organisation" option, and null is how the server
            // stores that. Sending the empty string would look for a buyer
            // whose id is nothing.
            appliesToOrgId: form.appliesToOrgId || null,
            active: form.active,
          },
        }),
      { success: "Coupon created.", error: "Could not create the coupon" },
    );
    setBusy(false);
    if (result) {
      setOpen(false);
      router.refresh();
    }
  }

  const valid = form.percent > 0 && form.percent <= 100 && form.expiresAt > form.startsAt;

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        New coupon
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create a coupon</DialogTitle>
            <DialogDescription>
              Organisations enter the code while buying seats. The discount is applied server-side.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
              <Field label="Code" htmlFor="code" hint="Leave blank to generate one.">
                <Input
                  id="code"
                  value={form.code}
                  onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
                  placeholder="LAUNCH10"
                  className="font-mono uppercase"
                />
              </Field>
              <Field label="Discount %" htmlFor="percent" required>
                <NumberField
                  id="percent"
                  min={0.01}
                  max={100}
                  decimals={2}
                  value={form.percent}
                  onValueChange={(v) => set("percent", v ?? 0)}
                  className="tabular"
                />
              </Field>
            </div>

            <Field label="Description" htmlFor="description">
              <Input
                id="description"
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="10% off for early customers"
              />
            </Field>

            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
              <Field label="Valid from" htmlFor="startsAt" required>
                <Input
                  id="startsAt"
                  type="date"
                  value={form.startsAt}
                  onChange={(e) => set("startsAt", e.target.value)}
                />
              </Field>
              <Field label="Valid until" htmlFor="expiresAt" required>
                <Input
                  id="expiresAt"
                  type="date"
                  value={form.expiresAt}
                  onChange={(e) => set("expiresAt", e.target.value)}
                />
              </Field>
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-3">
              <Field label="Max uses" htmlFor="maxRedemptions" hint="Blank = unlimited">
                <NumberField
                  id="maxRedemptions"
                  min={1}
                  value={form.maxRedemptions}
                  onValueChange={(v) => set("maxRedemptions", v)}
                  className="tabular"
                />
              </Field>
              <Field
                label="Per organisation"
                htmlFor="maxPerOrganisation"
                hint="Blank = as often as they like"
              >
                <NumberField
                  id="maxPerOrganisation"
                  min={1}
                  value={form.maxPerOrganisation}
                  onValueChange={(v) => set("maxPerOrganisation", v)}
                  className="tabular"
                />
              </Field>
              <Field label="Min users" htmlFor="minUserCount" hint="Blank = any">
                <NumberField
                  id="minUserCount"
                  min={1}
                  value={form.minUserCount}
                  onValueChange={(v) => set("minUserCount", v)}
                  className="tabular"
                />
              </Field>
              <Field label="Max users" htmlFor="maxUserCount" hint="Blank = any">
                <NumberField
                  id="maxUserCount"
                  min={1}
                  value={form.maxUserCount}
                  onValueChange={(v) => set("maxUserCount", v)}
                  className="tabular"
                />
              </Field>
            </div>

            <Field
              label="Cap the discount at (₹)"
              htmlFor="maxDiscountRupees"
              hint="Optional ceiling, so a large order cannot give away too much."
            >
              <NumberField
                id="maxDiscountRupees"
                min={1}
                decimals={2}
                value={form.maxDiscountRupees}
                onValueChange={(v) => set("maxDiscountRupees", v)}
                className="tabular"
                placeholder="2000"
              />
            </Field>

            {/**
              * Who it is for, when it starts working, and whether anybody can
              * find it. Three questions that used to have no field at all: a
              * coupon was always created switched on, always private, and
              * `appliesToOrgId` existed in the database and the service with
              * nothing anywhere in the product that could set it.
              */}
            {organisations.length > 0 ? (
              <Field
                label="Only for one organisation"
                htmlFor="appliesToOrgId"
                hint="Leave on 'Any' for a coupon anybody can use."
              >
                <Select
                  id="appliesToOrgId"
                  value={form.appliesToOrgId}
                  onChange={(e) => set("appliesToOrgId", e.target.value)}
                >
                  <option value="">Any organisation</option>
                  {organisations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}

            <div className="divide-y divide-border rounded-lg border border-border">
              <label className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Show it at checkout</span>
                  <span className="block text-xs text-muted-foreground">
                    Organisations see it in a list beside the code box. Off means the code has to
                    be given to them.
                  </span>
                </span>
                <Switch
                  checked={form.listed}
                  aria-label="Show it at checkout"
                  onCheckedChange={(v) => set("listed", v)}
                />
              </label>

              <label className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">First purchase only</span>
                  <span className="block text-xs text-muted-foreground">
                    Only for an organisation that has never had an order approved.
                  </span>
                </span>
                <Switch
                  checked={form.firstPurchaseOnly}
                  aria-label="First purchase only"
                  onCheckedChange={(v) => {
                    set("firstPurchaseOnly", v);
                    // A first purchase happens once, so a per-organisation
                    // limit above one could never be reached. Corrected here
                    // rather than refused on save.
                    if (v && (form.maxPerOrganisation ?? 0) > 1) set("maxPerOrganisation", 1);
                  }}
                />
              </label>

              <label className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block text-sm font-medium">Switch it on now</span>
                  <span className="block text-xs text-muted-foreground">
                    Off saves it ready to go, and nobody can redeem it until you switch it on.
                  </span>
                </span>
                <Switch
                  checked={form.active}
                  aria-label="Switch it on now"
                  onCheckedChange={(v) => set("active", v)}
                />
              </label>
            </div>

            <Alert tone="info" title="Worked example">
              <span className="flex items-center gap-1.5">
                <Wand2 className="size-4 shrink-0" aria-hidden />
                {sampleSeats} seats cost {formatMoney(sampleSubtotal)} a month. This coupon takes
                off {formatMoney(sampleDiscount)}
                {cap != null && rawDiscount > cap ? " (capped)" : ""}, leaving{" "}
                <strong>{formatMoney(sampleSubtotal - sampleDiscount)}</strong>.
              </span>
            </Alert>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button loading={busy} disabled={!valid} onClick={submit}>
              <TicketPercent className="size-4" aria-hidden />
              Create coupon
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Publishing a coupon that already exists.
 *
 * The switch on the creation dialog only ever reaches coupons made after it
 * shipped, and the four already in the database are exactly the ones somebody
 * would want to publish first. The route has always accepted `listed`; without
 * this there was no screen that could send it.
 */
export function CouponListedToggle({
  couponId,
  code,
  listed,
}: {
  couponId: string;
  code: string;
  listed: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [on, setOn] = useState(listed);

  async function toggle(next: boolean) {
    setBusy(true);
    // Moved at once and put back on failure. A switch that waits for a server
    // round trip before it moves reads as a switch that did not work.
    setOn(next);
    const result = await mutate(
      () =>
        api(`/api/platform/coupons/${couponId}`, {
          method: "PATCH",
          body: { listed: next },
        }),
      {
        success: next
          ? `${code} now appears at checkout.`
          : `${code} is code-only again.`,
        error: "Nothing changed",
      },
    );
    setBusy(false);
    if (result) router.refresh();
    else setOn(listed);
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Switch
        checked={on}
        disabled={busy}
        aria-label={`Show ${code} at checkout`}
        onCheckedChange={(v) => void toggle(v)}
      />
      <span className="text-xs text-muted-foreground">At checkout</span>
    </span>
  );
}

/** Coupons that have been redeemed are deactivated rather than deleted. */
export function CouponToggle({
  couponId,
  active,
  redemptionCount,
}: {
  couponId: string;
  active: boolean;
  redemptionCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const result = await mutate(
      () =>
        active
          ? api(`/api/platform/coupons/${couponId}`, { method: "DELETE" })
          : api(`/api/platform/coupons/${couponId}`, {
              method: "PATCH",
              body: { active: true },
            }),
      {
        success: active
          ? redemptionCount > 0
            ? "Coupon deactivated — its redemption history is kept."
            : "Coupon deleted."
          : "Coupon reactivated.",
      },
    );
    setBusy(false);
    if (result !== null) router.refresh();
  }

  return (
    <Button size="sm" variant="outline" loading={busy} onClick={toggle}>
      <Power className="size-4" aria-hidden />
      {active ? (redemptionCount > 0 ? "Deactivate" : "Delete") : "Reactivate"}
    </Button>
  );
}
