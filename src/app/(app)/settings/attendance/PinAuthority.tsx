"use client";

import { useEffect, useState } from "react";
import { KeyRound, Trash2, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/ui/label";
import { Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";

/**
 * Who may hand out an attendance PIN.
 *
 * A PIN is the only way past a face check that will not pass, and until now the
 * answer to "who can give me one?" lived in code: whoever held
 * `attendance.override`, or the person's own reporting manager. Neither was
 * visible to an administrator and neither could be changed.
 *
 * Three ways to grant, and they are not alternatives -- an organisation will
 * use more than one. A **role** is the login level ("every HR manager can"),
 * a **designation** covers the shape of the office ("every Shift Supervisor
 * can"), and a **person** covers the exception ("and Rahul on the front
 * desk"). Owner and Admin are always on: the tab and the widget are gated on
 * the permission their role carries.
 */

interface Row {
  id: string;
  kind: "DESIGNATION" | "EMPLOYEE";
  label: string;
  detail: string | null;
  targetId: string;
}

interface RoleRow {
  role: string;
  label: string;
  granted: boolean;
  always: boolean;
  rowId: string | null;
}

interface Payload {
  roles: RoleRow[];
  rows: Row[];
  designations: { id: string; title: string }[];
  employees: { id: string; name: string; code: string; designation: string | null }[];
}

export function PinAuthority({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [designationId, setDesignationId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const result = await api<Payload>("/api/settings/attendance/pin-authority").catch(() => null);
    if (result) setData(result);
  }

  useEffect(() => {
    void load();
  }, []);

  async function grant(body: { designationId?: string; employeeId?: string; role?: string }) {
    setBusy(true);
    const result = await mutate<Payload>(
      () =>
        api<Payload>("/api/settings/attendance/pin-authority", {
          method: "POST",
          body,
        }),
      { success: "They can issue attendance PINs now." },
    );
    setBusy(false);
    if (result) {
      setData(result);
      setDesignationId("");
      setEmployeeId("");
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    const result = await mutate<Payload>(
      () =>
        api<Payload>("/api/settings/attendance/pin-authority", {
          method: "DELETE",
          body: { id },
        }),
      { success: "Removed." },
    );
    setBusy(false);
    if (result) setData(result);
  }

  const taken = new Set(data?.rows.map((r) => r.targetId) ?? []);
  const designations = (data?.designations ?? []).filter((d) => !taken.has(d.id));
  const employees = (data?.employees ?? []).filter((e) => !taken.has(e.id));

  return (
    <Section
      title="Who can issue an attendance PIN"
      description="A one-time code for somebody whose face will not scan. It lasts fifteen minutes, works once, and the attendance it marks is recorded as unverified."
    >
      <div className="space-y-4">
        {/**
          * Which logins may issue, as one switch per role.
          *
          * "pin generate admin to kar hi sake, ye access default on rahega" --
          * and the rest by the owner's tick. Owner and Admin are shown on and
          * locked so the answer to "can an admin?" is visible rather than
          * implied.
          */}
        {data ? (
          <div className="rounded-lg border border-border">
            <p className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              By role
            </p>
            <ul className="divide-y divide-border">
              {data.roles.map((r) => (
                <li key={r.role} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{r.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.always ? "Always" : r.granted ? "Everybody with this login" : "Not unless named below"}
                    </p>
                  </div>
                  <Switch
                    checked={r.granted}
                    disabled={!canWrite || r.always || busy}
                    aria-label={`${r.label} may issue attendance PINs`}
                    onCheckedChange={(on) =>
                      on ? void grant({ role: r.role }) : r.rowId ? void revoke(r.rowId) : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {data === null ? (
          <p className="text-sm text-muted-foreground">Loading&hellip;</p>
        ) : data.rows.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="Nobody has been named by designation or in person"
            description="The roles above decide most of it. Naming a designation or a person here adds to that; so does being somebody's own reporting manager."
          />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {data.rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2.5">
                  {row.kind === "DESIGNATION" ? (
                    <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  ) : (
                    <UserRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{row.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.kind === "DESIGNATION" ? "Everyone with this designation" : row.detail}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={row.kind === "DESIGNATION" ? "info" : "neutral"}>
                    {row.kind === "DESIGNATION" ? "Designation" : "Person"}
                  </Badge>
                  {canWrite ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void revoke(row.id)}
                      aria-label={`Remove ${row.label}`}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {canWrite && data ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field
              label="Allow a designation"
              htmlFor="pinDesignation"
              hint="Everybody holding it, including people hired into it later."
            >
              <div className="flex gap-2">
                <Select
                  id="pinDesignation"
                  value={designationId}
                  onChange={(e) => setDesignationId(e.target.value)}
                >
                  <option value="">Choose&hellip;</option>
                  {designations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  disabled={busy || !designationId}
                  onClick={() => void grant({ designationId })}
                >
                  Add
                </Button>
              </div>
            </Field>

            <Field
              label="Allow one person"
              htmlFor="pinEmployee"
              hint="For the exception a designation does not describe."
            >
              <div className="flex gap-2">
                <Select
                  id="pinEmployee"
                  value={employeeId}
                  onChange={(e) => setEmployeeId(e.target.value)}
                >
                  <option value="">Choose&hellip;</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} · {e.code}
                      {e.designation ? ` · ${e.designation}` : ""}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  disabled={busy || !employeeId}
                  onClick={() => void grant({ employeeId })}
                >
                  Add
                </Button>
              </div>
            </Field>
          </div>
        ) : null}

        <Alert tone="info" title="Every PIN is recorded">
          Attendance marked with a PIN is flagged as unverified, and the audit log names who issued
          it and why. That is deliberate: a PIN is a manual override, and the record should say so.
        </Alert>
      </div>
    </Section>
  );
}
