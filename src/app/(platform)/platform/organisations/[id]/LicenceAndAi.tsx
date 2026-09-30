"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";

/**
 * What the platform owner can change about one organisation after it exists.
 *
 * Commercials move — a trial gets extended while a purchase order works its way
 * through somebody's finance team, seats go up mid-year, a cycle changes at
 * renewal. The alternative to this screen is editing the database by hand, which
 * is how a payroll system's billing quietly stops matching what was agreed.
 *
 * The AI key is here because some customers will not paste an OpenRouter key
 * into a screen themselves; they send it over and expect Broadmate to enter it.
 * That is a legitimate way to work, and the alternative is the key living in a
 * chat thread. The toggle beside it decides whether that organisation's own
 * administrator may set the key at all — enforced in the service, not merely
 * hidden here.
 */

interface Props {
  organizationId: string;
  subscription: {
    seats: number;
    billingMode: string;
    billingCycle: string;
    currentPeriodEnd: string;
    status: string;
  } | null;
}

interface AiView {
  keyHint: string | null;
  orgMayManageKey: boolean;
  model: string;
  monthlyTokenCap: number | null;
}

export function LicenceAndAi({ organizationId, subscription }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const [seats, setSeats] = useState(String(subscription?.seats ?? 0));
  const [mode, setMode] = useState(subscription?.billingMode ?? "TRIAL");
  const [cycle, setCycle] = useState(subscription?.billingCycle ?? "ANNUAL");
  const [expiry, setExpiry] = useState(subscription?.currentPeriodEnd?.slice(0, 10) ?? "");
  const [active, setActive] = useState(subscription?.status === "ACTIVE");

  const [ai, setAi] = useState<AiView | null>(null);
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    void api<AiView>(`/api/platform/organizations/${organizationId}/ai`)
      .then(setAi)
      .catch(() => undefined);
  }, [organizationId]);

  async function saveLicence() {
    setBusy(true);
    const done = await mutate(
      () =>
        api(`/api/platform/organizations/${organizationId}/subscription`, {
          method: "PATCH",
          body: {
            seats: Number(seats) || 0,
            billingMode: mode,
            billingCycle: cycle,
            currentPeriodEnd: expiry || undefined,
            active,
          },
        }),
      { success: "Licence updated.", error: "Nothing was changed" },
    );
    setBusy(false);
    if (done) router.refresh();
  }

  async function saveAi(patch: Record<string, unknown>, success: string) {
    setBusy(true);
    const result = await mutate(
      () =>
        api<AiView>(`/api/platform/organizations/${organizationId}/ai`, {
          method: "PATCH",
          body: patch,
        }),
      { success, error: "Nothing was changed" },
    );
    setBusy(false);
    if (result) {
      setAi(result);
      setApiKey("");
    }
  }

  return (
    <div className="space-y-4">
      <Section title="Licence" description="Seats, billing and when this one runs out.">
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
            <Field label="Seats" htmlFor="licSeats" hint="How many people they may activate.">
              <Input
                id="licSeats"
                type="number"
                min={0}
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
                className="tabular"
              />
            </Field>

            <Field label="Billing" htmlFor="licMode">
              <Select
                id="licMode"
                value={mode}
                onChange={(e) => {
                  // Moving to Paid from a trial is "they have paid", not "lock
                  // them out": the switch that decides read-only defaults on
                  // for the conversion and is still there to flip.
                  if (e.target.value === "PAID" && mode !== "PAID") setActive(true);
                  setMode(e.target.value);
                }}
              >
                <option value="TRIAL">Trial</option>
                <option value="PAID">Paid</option>
                <option value="FREE_INTERNAL">Free / internal</option>
              </Select>
            </Field>

            {mode === "PAID" ? (
              <Field label="Renews every" htmlFor="licCycle">
                <Select id="licCycle" value={cycle} onChange={(e) => setCycle(e.target.value)}>
                  <option value="MONTHLY">Month</option>
                  <option value="QUARTERLY">Quarter</option>
                  <option value="HALF_YEARLY">Six months</option>
                  <option value="ANNUAL">Year</option>
                </Select>
              </Field>
            ) : null}

            <Field
              label={mode === "TRIAL" ? "Trial ends" : "Licence expires"}
              htmlFor="licExpiry"
              hint="Set it to whatever was agreed — it is not derived from the cycle."
            >
              <Input
                id="licExpiry"
                type="date"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              />
            </Field>
          </div>

          {mode === "PAID" ? (
            /**
             * Only for a paying organisation, because only there does it do
             * anything: off marks the subscription past due, and a paid
             * organisation marked past due is read-only whatever its dates
             * say (`resolveAccessState`). A trial runs to its end date and a
             * free organisation is unmetered, switch or no switch, so showing
             * it there would be a promise the product does not keep.
             */
            <div className="flex items-center gap-3 rounded-lg border border-border p-3">
              <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Paid up</p>
                <p className="text-xs text-muted-foreground">
                  Off makes the organisation read-only, whatever the expiry date says, until a
                  payment is approved or this is switched back on. They can still sign in and
                  reach their billing page.
                </p>
              </div>
              <Switch checked={active} disabled={busy} aria-label="Paid up" onCheckedChange={setActive} />
            </div>
          ) : null}

          <Button loading={busy} disabled={busy} onClick={() => void saveLicence()}>
            Save licence
          </Button>
        </div>
      </Section>

      <Section
        title="AI credentials"
        description="Whose OpenRouter key this organisation uses, and who is allowed to set it."
      >
        <div className="space-y-4 p-4">
          <div className="flex items-center gap-3 rounded-lg border border-border p-3">
            <KeyRound className="size-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">They may set their own key</p>
              <p className="text-xs text-muted-foreground">
                Off means Broadmate holds it: they send the key over and you paste it below.
                Their own screen says so rather than offering a field that would be refused.
              </p>
            </div>
            <Switch
              checked={ai?.orgMayManageKey ?? true}
              disabled={busy || !ai}
              aria-label="Organisation may manage its own key"
              onCheckedChange={(v) =>
                void saveAi(
                  { orgMayManageKey: v },
                  v ? "They can set their own key now." : "Broadmate holds the key now.",
                )
              }
            />
          </div>

          <Alert tone="info" title={ai?.keyHint ? `A key is set — ${ai.keyHint}` : "No key set"}>
            {ai?.keyHint
              ? "Entering a new one replaces it. It is encrypted at rest and never shown again."
              : "Without one, this organisation falls back to the platform key if there is one, and otherwise AI features are unavailable to them."}
          </Alert>

          <Field
            label="Set their OpenRouter key"
            htmlFor="orgKey"
            hint="Paste it on one line. It is encrypted immediately and never returned."
          >
            <Input
              id="orgKey"
              type="password"
              autoComplete="off"
              placeholder="sk-or-v1-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button
              loading={busy}
              disabled={busy || apiKey.trim().length < 20}
              onClick={() => void saveAi({ apiKey: apiKey.trim() }, "Key saved for them.")}
            >
              Save key
            </Button>
            {ai?.keyHint ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => void saveAi({ apiKey: "" }, "Key removed.")}
              >
                Remove the key
              </Button>
            ) : null}
          </div>
        </div>
      </Section>
    </div>
  );
}
