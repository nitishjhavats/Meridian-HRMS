"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Play, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
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
import { MODULES } from "@/lib/features";
import type { ModuleState } from "@/lib/features";

/**
 * Level 1 of the feature system: what this organisation is allowed to use.
 *
 * Revoking a grant also switches the module off, so restoring the grant later
 * does not silently turn a module back on for a tenant that had chosen to
 * disable it.
 */
export function FeatureGrants({
  organizationId,
  modules,
}: {
  organizationId: string;
  modules: Record<string, ModuleState>;
}) {
  const router = useRouter();
  const [granted, setGranted] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MODULES.map((m) => [m.key, modules[m.key]?.granted ?? m.defaultGranted])),
  );
  const [busy, setBusy] = useState(false);

  const dirty = MODULES.some(
    (m) => !m.core && granted[m.key] !== (modules[m.key]?.granted ?? m.defaultGranted),
  );

  async function save() {
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/platform/organizations/${organizationId}/features`, {
          method: "PATCH",
          body: { grants: Object.fromEntries(MODULES.filter((m) => !m.core).map((m) => [m.key, granted[m.key] ?? false])) },
        }),
      { success: "Module access updated." },
    );
    setBusy(false);
    if (result) router.refresh();
  }

  return (
    <div className="p-4">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
        {MODULES.map((module) => {
          const state = modules[module.key];
          return (
            <label
              key={module.key}
              className="flex items-start gap-2.5 rounded-md border border-border p-3 text-sm"
            >
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={module.core || (granted[module.key] ?? false)}
                disabled={module.core}
                onChange={(e) =>
                  setGranted((prev) => ({ ...prev, [module.key]: e.target.checked }))
                }
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium">{module.name}</span>
                  {module.core ? (
                    <span className="text-xs text-muted-foreground">always on</span>
                  ) : state?.live ? (
                    <span className="inline-flex items-center gap-0.5 text-xs text-success-text">
                      <Check className="size-3" aria-hidden />
                      live
                    </span>
                  ) : state?.granted ? (
                    <span className="text-xs text-muted-foreground">
                      {state.blockedBy === "MISSING_DEPENDENCY"
                        ? `needs ${state.missingDependency}`
                        : "off by their admin"}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {module.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>

      {dirty ? (
        <div className="mt-3 flex justify-end">
          <Button loading={busy} onClick={save}>
            <Save className="size-4" aria-hidden />
            Save module access
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function StatusControls({
  organizationId,
  organizationName,
  status,
  seats,
}: {
  organizationId: string;
  organizationName: string;
  status: string;
  seats: number;
}) {
  const router = useRouter();
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState("");
  const [seatValue, setSeatValue] = useState(seats);
  const [busy, setBusy] = useState(false);

  async function setStatus(next: string, why?: string) {
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/platform/organizations/${organizationId}/status`, {
          method: "POST",
          body: { status: next, reason: why },
        }),
      {
        success:
          next === "SUSPENDED"
            ? `${organizationName} suspended — everyone has been signed out.`
            : `${organizationName} reactivated.`,
      },
    );
    setBusy(false);
    if (result) {
      setSuspending(false);
      setReason("");
      router.refresh();
    }
  }

  async function saveSeats() {
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/platform/organizations/${organizationId}`, {
          method: "PATCH",
          body: { seats: seatValue },
        }),
      { success: "Seat limit updated." },
    );
    setBusy(false);
    if (result) router.refresh();
  }

  return (
    <div className="space-y-4 p-4">
      <Field
        label="Seat limit"
        htmlFor="seats"
        hint="Overrides the purchased count. Lowering it does not deactivate anyone already active."
      >
        <div className="flex gap-2">
          <NumberField
            id="seats"
            min={0}
            max={10_000}
            value={seatValue}
            // Zero is a deliberate setting here: it stops every new activation.
            onValueChange={(v) => setSeatValue(v ?? 0)}
            className="tabular"
          />
          <Button variant="outline" loading={busy} disabled={seatValue === seats} onClick={saveSeats}>
            Save
          </Button>
        </div>
      </Field>

      <div className="border-t border-border pt-4">
        {status === "SUSPENDED" || status === "ARCHIVED" ? (
          <>
            <p className="mb-2 text-sm text-muted-foreground">
              This organisation is {status.toLowerCase()}. Nobody can sign in.
            </p>
            <Button variant="success" loading={busy} onClick={() => setStatus("ACTIVE")}>
              <Play className="size-4" aria-hidden />
              Reactivate
            </Button>
          </>
        ) : (
          <>
            <p className="mb-2 text-sm text-muted-foreground">
              Suspending signs every user out immediately and blocks new sign-ins.
            </p>
            <Button variant="danger" onClick={() => setSuspending(true)}>
              <Ban className="size-4" aria-hidden />
              Suspend organisation
            </Button>
          </>
        )}
      </div>

      <Dialog open={suspending} onOpenChange={setSuspending}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Suspend {organizationName}?</DialogTitle>
            <DialogDescription>This takes effect immediately.</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Alert tone="danger" title="What happens">
              Every active session is revoked and nobody from this organisation can sign in until
              you reactivate it. Their data is untouched.
            </Alert>
            <Field label="Reason" htmlFor="reason" required hint="Recorded in the audit log.">
              <Textarea
                id="reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Non-payment after repeated reminders"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSuspending(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              disabled={!reason.trim()}
              onClick={() => setStatus("SUSPENDED", reason.trim())}
            >
              Suspend
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
