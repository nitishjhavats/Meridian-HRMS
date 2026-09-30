"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Section } from "@/components/ui/stat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";

/**
 * How many days of each leave type a designation gets.
 *
 * `LeaveType.annualAllocation` was one number for the whole company, which is
 * not how leave works anywhere: a manager and a trainee do not get the same
 * casual leave.
 *
 * A grid rather than a form, because the question an administrator is actually
 * asking is "who gets what", and that is a table. A blank cell means the
 * designation follows the company number shown in the column heading — clearing
 * a cell is how you go back to it.
 *
 * The last column is not a leave type. "Paid week offs a month" is the role's
 * quota for payroll's unused-week-off rule: it overrides the payroll rule and a
 * person's own number on their profile overrides it. The on-demand week off is
 * deliberately absent as a column — the service leaves it out — because it is
 * a bank of extra rest days handed to one person on the grid above, and two
 * columns both called "week off" with different meanings is how the wrong one
 * gets filled in.
 */

interface Payload {
  types: { id: string; code: string; name: string; annualAllocation: number }[];
  designations: { id: string; title: string; weekOffsPerMonth: number | null }[];
  overrides: Record<string, number>;
}

/** The week-off column's cell key, which cannot collide with a leave type id. */
const WEEK_OFF = "weekOff";

export function DesignationAllocations({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** What is in each box while it is being typed in. */
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    void api<Payload>("/api/settings/leave-allocations")
      .then(setData)
      .catch(() => undefined);
  }, []);

  async function commit(leaveTypeId: string, designationId: string, raw: string) {
    const cell = `${leaveTypeId}:${designationId}`;
    const trimmed = raw.trim();
    const days = trimmed === "" ? null : Number(trimmed);
    if (days !== null && (!Number.isFinite(days) || days < 0)) return;

    // Nothing changed, so nothing is written -- a blur is not an edit.
    if ((data?.overrides[cell] ?? null) === days) return;

    setBusy(cell);
    const result = await mutate<Payload>(
      () =>
        api("/api/settings/leave-allocations", {
          method: "PATCH",
          body: { leaveTypeId, designationId, days },
        }),
      { success: days === null ? "Back to the company allocation." : "Saved." },
    );
    setBusy(null);
    if (result) {
      setData(result);
      setDraft((d) => {
        const next = { ...d };
        delete next[cell];
        return next;
      });
    }
  }

  async function commitWeekOffs(designationId: string, raw: string) {
    const cell = `${WEEK_OFF}:${designationId}`;
    const trimmed = raw.trim();
    const weekOffsPerMonth = trimmed === "" ? null : Number(trimmed);
    if (
      weekOffsPerMonth !== null &&
      (!Number.isInteger(weekOffsPerMonth) || weekOffsPerMonth < 0 || weekOffsPerMonth > 31)
    ) {
      return;
    }

    const current =
      data?.designations.find((d) => d.id === designationId)?.weekOffsPerMonth ?? null;
    if (current === weekOffsPerMonth) return;

    setBusy(cell);
    const result = await mutate<Payload>(
      () =>
        api("/api/settings/leave-allocations", {
          method: "PATCH",
          body: { designationId, weekOffsPerMonth },
        }),
      {
        success:
          weekOffsPerMonth === null ? "Back to the payroll rule." : "Saved.",
      },
    );
    setBusy(null);
    if (result) {
      setData(result);
      setDraft((d) => {
        const next = { ...d };
        delete next[cell];
        return next;
      });
    }
  }

  /**
   * Save everything still being typed in.
   *
   * Every cell already commits on blur, which is genuinely how a grid like this
   * should behave — but a screen with no Save button leaves somebody wondering
   * whether what they typed took, and the honest answer to "kya ye save ho
   * gaya" should be a button that says so rather than a habit they have to
   * learn. This commits whatever has not been blurred yet and confirms the rest.
   */
  async function saveAll() {
    const pending = Object.entries(draft);
    setBusy("all");
    for (const [cell, raw] of pending) {
      const [left, designationId] = cell.split(":");
      if (!left || !designationId) continue;
      if (left === WEEK_OFF) await commitWeekOffs(designationId, raw);
      else await commit(left, designationId, raw);
    }
    setBusy(null);
  }

  if (!data) return null;

  // Only the rows are needed. A new organisation has one active leave type
  // and it is the on-demand week off, which is not a column here -- so waiting
  // for a leave type would hide the paid-quota column exactly when it is the
  // one thing there is to set.
  if (data.designations.length === 0) {
    return (
      <Section title="Leave by designation">
        <div className="p-4">
          <Alert tone="info" title="Nothing to set yet">
            Add designations first, and this grid fills itself in.
          </Alert>
        </div>
      </Section>
    );
  }

  return (
    <Section
      title="Leave by designation"
      description="Days a year, by role. A blank cell follows the company allocation in the column heading; one person's own figure is still set in the grid above."
      action={
        canWrite ? (
          <Button size="sm" variant="secondary" loading={busy === "all"} onClick={saveAll}>
            <Save className="size-4" aria-hidden />
            Save
          </Button>
        ) : undefined
      }
    >
      <div className="overflow-x-auto p-4">
        <table className="w-full min-w-[32rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="py-2 pr-3 font-medium">
                Designation
              </th>
              {data.types.map((type) => (
                <th key={type.id} scope="col" className="px-2 py-2 text-xs font-medium">
                  <span className="block">{type.name}</span>
                  <span className="block font-normal text-muted-foreground">
                    company: {type.annualAllocation}
                  </span>
                </th>
              ))}
              <th scope="col" className="px-2 py-2 text-xs font-medium">
                <span className="block">Paid week offs</span>
                <span className="block font-normal text-muted-foreground">a month</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.designations.map((designation) => (
              <tr key={designation.id} className="border-b border-border last:border-0">
                <th scope="row" className="py-2 pr-3 text-left text-sm font-medium">
                  {designation.title}
                </th>
                {data.types.map((type) => {
                  const cell = `${type.id}:${designation.id}`;
                  const stored = data.overrides[cell];
                  return (
                    <td key={type.id} className="px-2 py-1.5">
                      <Input
                        type="number"
                        min={0}
                        max={365}
                        step="0.5"
                        className="tabular w-20"
                        aria-label={`${type.name} for ${designation.title}`}
                        disabled={!canWrite || busy === cell}
                        placeholder={String(type.annualAllocation)}
                        value={draft[cell] ?? (stored === undefined ? "" : String(stored))}
                        onChange={(e) => setDraft((d) => ({ ...d, [cell]: e.target.value }))}
                        onBlur={(e) => void commit(type.id, designation.id, e.target.value)}
                      />
                    </td>
                  );
                })}
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    min={0}
                    max={31}
                    step="1"
                    className="tabular w-20"
                    aria-label={`Paid week offs a month for ${designation.title}`}
                    disabled={!canWrite || busy === `${WEEK_OFF}:${designation.id}`}
                    placeholder="rule"
                    value={
                      draft[`${WEEK_OFF}:${designation.id}`] ??
                      (designation.weekOffsPerMonth === null
                        ? ""
                        : String(designation.weekOffsPerMonth))
                    }
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [`${WEEK_OFF}:${designation.id}`]: e.target.value }))
                    }
                    onBlur={(e) => void commitWeekOffs(designation.id, e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted-foreground">
          Paid week offs a month is the quota payroll measures rest days against: it
          overrides the payroll rule, and a person&rsquo;s own number on their profile
          overrides it. Blank follows the rule. The on-demand week off is not a column
          here &mdash; it is a leave type allocated per person in the grid above.
        </p>
      </div>
    </Section>
  );
}
