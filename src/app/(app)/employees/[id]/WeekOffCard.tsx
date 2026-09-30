"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { NumberField } from "@/components/ui/number-field";
import { Section } from "@/components/ui/stat";
import { Switch } from "@/components/ui/switch";
import { api, mutate } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { describeWeeklyOff, personalWeeklyOff, personalWeeklyOffErrors } from "@/domain/calendar/weeklyOff";

/**
 * One person's rest days, and how many a month payroll owes them.
 *
 * Before this the only per-person control was the pattern select in the edit
 * dialog, and "everybody is off on Sunday except the guard, who is off on
 * Tuesday" needed a one-person pattern in the organisation's calendar for
 * every exception. The chips here write `Employee.weeklyOffConfig`, which the
 * resolver consults before any pattern; the select is still offered because
 * a rota the chips cannot say -- "2nd and 4th Saturday" -- is a named pattern.
 *
 * The quota is the third layer of the same shape leave allocation has: the
 * person, then their designation, then the payroll rule. The hint under the
 * box says what a blank falls through to, in the actual figures, because a
 * blank whose meaning depends on two other screens is a blank nobody dares
 * leave.
 *
 * A draft and a Save, rather than a write on every click: turning the switch
 * off starts with no days chosen, and a chip-by-chip save would write "no rest
 * days" for the moment between the switch and the first chip.
 */

const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface WeekOffPatternChoice {
  id: string;
  name: string;
  summary: string;
  /** Switched off in Settings; still named here for anybody left on it. */
  active: boolean;
}

export interface WeekOffCardProps {
  employeeId: string;
  name: string;
  /** `employee.update`. Everybody who can open the profile reads the card. */
  canEdit: boolean;
  /** Their own weekdays, or null when they follow a pattern. */
  personalDays: number[] | null;
  /** Where the chips start from when their own days are switched on. */
  seedDays: number[];
  patternId: string | null;
  patterns: WeekOffPatternChoice[];
  organisationDefaultSummary: string;
  weekOffsPerMonth: number | null;
  /** `Designation.weekOffsPerMonth`, the layer a blank personal quota falls to. */
  designationQuota: number | null;
  /** The payroll rule's `weekOff.quotaPerMonth`; undefined when payroll is off. */
  policyQuota: number | null | undefined;
}

/** What "same as the organisation" resolves to for this person, in words. */
function followsLabel(patternId: string | null, patterns: WeekOffPatternChoice[], organisationDefaultSummary: string) {
  const pattern = patternId ? patterns.find((p) => p.id === patternId) : null;
  return pattern
    ? `Follows ${pattern.name}${pattern.active ? "" : " (switched off)"} (${pattern.summary})`
    : `Same as organisation (${organisationDefaultSummary})`;
}

function quotaHint(designationQuota: number | null, policyQuota: number | null | undefined) {
  const designation = designationQuota ?? "not set";
  const rule =
    policyQuota === undefined ? "payroll off" : policyQuota ?? "as many as the pattern gives";
  return `blank = designation (${designation}) / payroll rule (${rule})`;
}

export function WeekOffCard(props: WeekOffCardProps) {
  return (
    <Section title="Week off" description="Which days they rest, and how many a month payroll owes them.">
      <div className="p-4">{props.canEdit ? <Editor {...props} /> : <Summary {...props} />}</div>
    </Section>
  );
}

function Summary({
  personalDays,
  patternId,
  patterns,
  organisationDefaultSummary,
  weekOffsPerMonth,
  designationQuota,
  policyQuota,
}: WeekOffCardProps) {
  const restDays = personalDays
    ? `${describeWeeklyOff(personalWeeklyOff(personalDays))} (their own)`
    : followsLabel(patternId, patterns, organisationDefaultSummary);
  const quota =
    weekOffsPerMonth != null
      ? `${weekOffsPerMonth} (their own)`
      : designationQuota != null
        ? `${designationQuota} (designation)`
        : policyQuota != null
          ? `${policyQuota} (payroll rule)`
          : "As many as the pattern gives";

  return (
    <dl className="space-y-2 text-sm">
      <div className="flex items-start gap-2">
        <CalendarDays className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <dt className="text-xs text-muted-foreground">Rest days</dt>
          <dd>{restDays}</dd>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <CalendarDays className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <dt className="text-xs text-muted-foreground">Week offs a month</dt>
          <dd>{quota}</dd>
        </div>
      </div>
    </dl>
  );
}

function Editor({
  employeeId,
  name,
  personalDays,
  seedDays,
  patternId: savedPatternId,
  patterns,
  organisationDefaultSummary,
  weekOffsPerMonth,
  designationQuota,
  policyQuota,
}: WeekOffCardProps) {
  const router = useRouter();
  const [ownDays, setOwnDays] = useState(personalDays !== null);
  const [days, setDays] = useState<number[]>(personalDays ?? seedDays);
  const [patternId, setPatternId] = useState(savedPatternId ?? "");
  const [quota, setQuota] = useState<number | null>(weekOffsPerMonth);
  const [busy, setBusy] = useState(false);

  const dayErrors = ownDays ? personalWeeklyOffErrors(days) : [];

  // What the PATCH would carry, against what the row holds. The same
  // normalisation on both sides, so re-ordering chips is not a change.
  const outgoing = ownDays ? personalWeeklyOff(days) : null;
  const stored = personalDays ? personalWeeklyOff(personalDays) : null;
  const changed =
    JSON.stringify(outgoing) !== JSON.stringify(stored) ||
    patternId !== (savedPatternId ?? "") ||
    quota !== weekOffsPerMonth;

  function toggleDay(day: number) {
    setDays((current) =>
      current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort((a, b) => a - b),
    );
  }

  async function save() {
    setBusy(true);
    const pattern = patternId ? patterns.find((p) => p.id === patternId) : null;
    const saved = await mutate(
      () =>
        api(`/api/employees/${employeeId}`, {
          method: "PATCH",
          body: {
            weeklyOffConfig: outgoing,
            weeklyOffPatternId: patternId || null,
            weekOffsPerMonth: quota,
          },
        }),
      {
        success: outgoing
          ? `${name} is off on ${describeWeeklyOff(outgoing)}.`
          : pattern
            ? `${name} follows ${pattern.name}.`
            : `${name} is on the organisation's week off.`,
        error: "Nothing was saved",
      },
    );
    setBusy(false);
    if (saved) router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {followsLabel(patternId || null, patterns, organisationDefaultSummary)}
          </p>
          <p className="text-xs text-muted-foreground">
            Switch off to give {name} their own days, whatever the pattern says.
          </p>
        </div>
        <Switch
          checked={!ownDays}
          disabled={busy}
          aria-label={followsLabel(patternId || null, patterns, organisationDefaultSummary)}
          onCheckedChange={(same) => setOwnDays(!same)}
        />
      </div>

      {ownDays ? (
        <div>
          <p className="mb-1.5 text-sm font-medium">Off every week</p>
          <div className="flex flex-wrap gap-1.5">
            {DAY_INITIALS.map((initial, day) => {
              const on = days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[day]}
                  disabled={busy}
                  onClick={() => toggleDay(day)}
                  className={cn(
                    "size-9 rounded-md border text-sm font-medium transition-colors",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:bg-muted",
                  )}
                >
                  {initial}
                </button>
              );
            })}
          </div>
          {dayErrors.length > 0 ? (
            <p className="mt-1.5 text-xs text-danger-text" role="alert">
              {dayErrors.join(" ")}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Consulted before any pattern. For a rota the chips cannot say, switch back on and
              pick a pattern instead.
            </p>
          )}
        </div>
      ) : (
        <Field
          label="Pattern"
          htmlFor="weekoff-pattern"
          hint="For rotas the day chips cannot say, such as 2nd and 4th Saturday. Patterns are kept under Settings, Calendar."
        >
          <Select
            id="weekoff-pattern"
            value={patternId}
            disabled={busy}
            onChange={(e) => setPatternId(e.target.value)}
          >
            <option value="">Organisation default ({organisationDefaultSummary})</option>
            {patterns.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.summary})
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field
        label="Week offs a month"
        htmlFor="weekoff-quota"
        hint={quotaHint(designationQuota, policyQuota)}
      >
        <NumberField
          id="weekoff-quota"
          value={quota}
          min={0}
          max={31}
          disabled={busy}
          placeholder={String(designationQuota ?? policyQuota ?? "")}
          onValueChange={setQuota}
        />
      </Field>

      <div className="flex justify-end">
        <Button
          size="sm"
          loading={busy}
          disabled={busy || !changed || dayErrors.length > 0}
          onClick={() => void save()}
        >
          Save week off
        </Button>
      </div>
    </div>
  );
}
