"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
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

/**
 * Moving somebody between employment states.
 *
 * `changeEmploymentState` and `POST /api/employees/[id]/state` have existed for
 * a while with nothing to call them, so the only way anybody's state ever moved
 * was through the exit module. That left the states the exit module does not
 * cover — training to probation, probation to confirmed, a rescinded
 * resignation coming back — unreachable, and it meant the login-disabling code
 * on this path never ran in practice.
 *
 * The reason is asked for and recorded, because "when did she go on notice, and
 * why?" is a question somebody asks a year later.
 */

const STATES = [
  { value: "TRAINING", label: "In training" },
  { value: "PROBATION", label: "On probation" },
  { value: "REGULAR", label: "Regular" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "NOTICE_PERIOD", label: "Serving notice" },
  { value: "RESIGNED", label: "Resigned" },
  { value: "TERMINATED", label: "Terminated" },
  { value: "INACTIVE", label: "Inactive" },
] as const;

/** The states that end the employment, free the seat and close the login. */
const LEAVING = new Set(["RESIGNED", "TERMINATED", "INACTIVE"]);

export function EmploymentState({
  employeeId,
  name,
  current,
  canTerminate,
}: {
  employeeId: string;
  name: string;
  current: string;
  /**
   * `employee.terminate`, which `changeEmploymentState` demands for the three
   * leaving states and which HR Managers and Managers do not hold. They still
   * hold `employee.state.change`, so the dialog is theirs -- but offering
   * "Resigned" to somebody the server will refuse it from is a control whose
   * only outcome is "You do not have permission to do that."
   */
  canTerminate: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [toState, setToState] = useState(current);
  const [effectiveOn, setEffectiveOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const leaving = LEAVING.has(toState);
  const returning = LEAVING.has(current) && !leaving;

  async function save() {
    setBusy(true);
    const done = await mutate(
      () =>
        api(`/api/employees/${employeeId}/state`, {
          method: "POST",
          body: { toState, effectiveOn, reason: reason.trim() || undefined },
        }),
      { success: `${name} is now ${toState.replaceAll("_", " ").toLowerCase()}.`, error: "Nothing was changed" },
    );
    setBusy(false);
    if (done) {
      setOpen(false);
      setReason("");
      router.refresh();
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <UserCog className="size-4" aria-hidden />
        Change state
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change {name}&rsquo;s employment state</DialogTitle>
            <DialogDescription>
              Recorded in their history with the date and the reason.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            {leaving ? (
              <Alert tone="warning" title="This ends their employment">
                Their seat is freed, their login is disabled and any session they have open is
                signed out immediately. Use the exit module instead if there is a notice period,
                a clearance list or a final settlement to work through.
              </Alert>
            ) : null}

            {returning ? (
              <Alert tone="info" title="This brings them back">
                Their login is re-enabled and they consume a seat again.
              </Alert>
            ) : null}

            <Field
              label="New state"
              htmlFor="toState"
              required
              hint={
                canTerminate
                  ? undefined
                  : "Resigned, terminated and inactive are not yours to set: an exit goes through the exit module, or an administrator ends the employment."
              }
            >
              <Select id="toState" value={toState} onChange={(e) => setToState(e.target.value)}>
                {STATES.map((s) => (
                  <option
                    key={s.value}
                    value={s.value}
                    disabled={s.value === current || (!canTerminate && LEAVING.has(s.value))}
                  >
                    {s.label}
                    {s.value === current ? " (current)" : ""}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Effective from"
              htmlFor="effectiveOn"
              required
              hint="The date it takes effect, which may not be today."
            >
              <Input
                id="effectiveOn"
                type="date"
                value={effectiveOn}
                onChange={(e) => setEffectiveOn(e.target.value)}
              />
            </Field>

            <Field label="Reason" htmlFor="stateReason" hint="Kept in their employment history.">
              <Input
                id="stateReason"
                value={reason}
                placeholder="Confirmed after probation review"
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </DialogBody>

          <DialogFooter>
            <Button
              loading={busy}
              disabled={busy || toState === current || (leaving && !canTerminate)}
              onClick={() => void save()}
            >
              Change state
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
