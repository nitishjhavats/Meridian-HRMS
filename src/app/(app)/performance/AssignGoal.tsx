"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Select, Textarea } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import {
  type RecognitionUnitKey,
  UNIT_LABELS,
} from "@/domain/recognition/units";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import { EmployeePicker, type PickablePerson } from "@/components/employees/EmployeePicker";
import { api, RequestFailed } from "@/lib/client/api";
import { toast } from "@/components/ui/toast";

/**
 * Setting one goal for several people.
 *
 * Until this existed, the only way to create a goal in the product was the text
 * box at the bottom of this screen, which always posted the signed-in user's
 * own employee id. Every goal in the database is therefore a goal somebody set
 * for themselves — a manager running a quarter had no way to say "everyone
 * ships their handover doc by the 30th" except to ask twelve people to type it.
 *
 * A goal belongs to one person, so this writes one row each. The dialog says
 * how many that is on the button, because "Assign" over a list of ticked
 * checkboxes is the shape of mistake nobody notices until the notifications
 * land.
 */
export function AssignGoal({ people }: { people: PickablePerson[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [unit, setUnit] = useState("");
  const [target, setTarget] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ assigned: number }>("/api/performance/goals", {
        method: "POST",
        body: {
          employeeIds: chosen,
          title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(dueOn ? { dueOn } : {}),
          // Both or neither: a target with no unit is a bare number nobody can
          // read, and a unit with no target measures nothing.
          ...(unit && target !== null ? { unit, targetNumber: target } : {}),
          status: "ACTIVE",
        },
      });
      toast.success(
        `Goal set for ${result.assigned} ${result.assigned === 1 ? "person" : "people"}. They have each been told.`,
      );
      setOpen(false);
      setChosen([]);
      setTitle("");
      setDescription("");
      setDueOn("");
      // The measure too. It was the one pair left behind, so the next goal
      // opened with last time's "Rupees, 500000" already in the boxes.
      setUnit("");
      setTarget(null);
      router.refresh();
    } catch (failure) {
      // The refusal is shown here rather than only in a toast, because the
      // server refuses the whole assignment when one of the ticked people no
      // longer resolves — and the list it was refused about is on this screen.
      setError(
        failure instanceof RequestFailed
          ? `${failure.error.message} Nobody has been given this goal.`
          : "That could not be saved. Nobody has been given this goal.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm">
          <Target className="size-4" aria-hidden />
          Assign a goal
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set a goal for your team</DialogTitle>
          <DialogDescription>
            Everybody you tick gets their own copy of this goal and is told about it. They can be
            marked achieved or missed one at a time afterwards.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {error ? <Alert tone="danger">{error}</Alert> : null}

          <Field label="The goal" htmlFor="assign-goal-title">
            <Input
              id="assign-goal-title"
              value={title}
              disabled={busy}
              placeholder="e.g. Hand over the reporting module"
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>

          <Field label="What it means, if it needs saying" htmlFor="assign-goal-detail">
            <Textarea
              id="assign-goal-detail"
              rows={2}
              value={description}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          {/**
            * The measure, which the dialog never collected.
            *
            * `manySchema` accepted `targetValue` and `weight` and this form sent
            * neither, so every goal ever assigned arrived with nothing to
            * measure it against -- and the copy below promising it could be
            * "marked achieved afterwards" pointed at a control that did not
            * exist. Both are here now.
            */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field
              label="Measured in"
              htmlFor="assign-goal-unit"
              hint="Leave it as words for a goal with no number."
            >
              <Select
                id="assign-goal-unit"
                value={unit}
                disabled={busy}
                onChange={(e) => setUnit(e.target.value)}
              >
                <option value="">Words, not a number</option>
                {(Object.keys(UNIT_LABELS) as RecognitionUnitKey[]).map((key) => (
                  <option key={key} value={key}>
                    {UNIT_LABELS[key]}
                  </option>
                ))}
              </Select>
            </Field>

            {unit ? (
              <Field label="Target" htmlFor="assign-goal-target" required>
                <NumberField
                  id="assign-goal-target"
                  min={0}
                  decimals={2}
                  className="tabular"
                  value={target}
                  disabled={busy}
                  onValueChange={setTarget}
                />
              </Field>
            ) : null}

            <Field label="Due by (optional)" htmlFor="assign-goal-due">
              <Input
                id="assign-goal-due"
                type="date"
                value={dueOn}
                disabled={busy}
                onChange={(e) => setDueOn(e.target.value)}
              />
            </Field>
          </div>

          <EmployeePicker people={people} selected={chosen} onChange={setChosen} disabled={busy} />
        </DialogBody>

        <DialogFooter>
          {/* A unit with no target would be sent as neither -- see the body
              above -- so the goal would arrive as words while the dialog
              showed "Rupees". The button waits for the number instead. */}
          <Button
            loading={busy}
            disabled={
              busy || chosen.length === 0 || title.trim().length < 2 || (unit !== "" && target === null)
            }
            onClick={() => void submit()}
          >
            Set this goal for {chosen.length} {chosen.length === 1 ? "person" : "people"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
