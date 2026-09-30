"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Lock, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Section, Stat, StatGrid } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
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
import { pluralise } from "@/lib/utils";
import type {
  PermissionRow,
  PermissionValue,
  UserPermissionView,
  UserSummary,
} from "@/services/org/permissions";

/**
 * One person, every permission, three ways.
 *
 * The three-way view is the whole design. "Ravi can disburse salary" is not a
 * useful sentence on a screen like this; "his role does not include it and
 * somebody added it for him" is, because it is the one that tells you whether to
 * be worried. So each row shows what the role gives, what has been overridden,
 * and what applies as a result — and the middle column is the only one anybody
 * can change.
 *
 * Nothing here decides what an option would mean. `row.outcomes` arrives from
 * the server, computed by `effectivePermissions` — the same function the guards
 * use — because a client that works out for itself what a grant would do is a
 * client that will eventually disagree with the server about who can lock
 * payroll.
 */

const VALUE_LABELS: Record<PermissionValue, string> = {
  grant: "Give",
  inherit: "Follow the role",
  revoke: "Take away",
};

const VALUES: PermissionValue[] = ["grant", "inherit", "revoke"];

export function PermissionManager({
  users,
  restricted,
  view,
  actorRoleLabel,
}: {
  users: UserSummary[];
  restricted: number;
  view: UserPermissionView;
  actorRoleLabel: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [confirming, setConfirming] = useState<{ row: PermissionRow; value: PermissionValue } | null>(
    null,
  );

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return view.groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter((row) => {
          if (onlyChanged && row.override === null) return false;
          if (!needle) return true;
          return (
            row.label.toLowerCase().includes(needle) ||
            row.description.toLowerCase().includes(needle) ||
            row.permission.toLowerCase().includes(needle)
          );
        }),
      }))
      .filter((group) => group.rows.length > 0);
  }, [view.groups, query, onlyChanged]);

  async function apply(row: PermissionRow, value: PermissionValue) {
    setBusy(row.permission);
    const done = await mutate(
      () =>
        api(`/api/settings/permissions/${view.user.id}`, {
          method: "PUT",
          body: { permission: row.permission, value },
        }),
      {
        success:
          value === "inherit"
            ? `${row.label} now follows the ${view.user.roleLabel} role.`
            : value === "grant"
              ? `${view.user.name} was given "${row.label}".`
              : `"${row.label}" was taken away from ${view.user.name}.`,
        error: "Nothing was changed",
      },
    );
    setBusy(null);
    setConfirming(null);
    // The list is the server's to rebuild. Recomputing it here would mean
    // reimplementing `effectivePermissions` in the browser, which is precisely
    // the drift this screen cannot afford.
    if (done) router.refresh();
  }

  function choose(row: PermissionRow, value: PermissionValue) {
    if (value === currentValue(row)) return;
    // Adding authority that moves money or exposes everybody is worth a second
    // look. Taking it away is not — nobody has ever regretted the pause before
    // removing a permission.
    if (row.sensitive && row.outcomes[value] && !row.effective) {
      setConfirming({ row, value });
      return;
    }
    void apply(row, value);
  }

  return (
    <div className="space-y-4">
      <Section
        title="Who you are adjusting"
        description="Changes apply to this person alone, and stay with them if their role changes."
      >
        <div className="space-y-4 p-4">
          <Field
            label="Person"
            htmlFor="permissionUser"
            hint={
              restricted > 0
                ? `${restricted} other ${restricted === 1 ? "login is" : "logins are"} not listed: your own account, anybody at or above your role, and office devices.`
                : undefined
            }
          >
            <Select
              id="permissionUser"
              className="max-w-md"
              value={view.user.id}
              disabled={busy !== null}
              onChange={(e) => router.push(`/settings/permissions?user=${e.target.value}`)}
            >
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {describeUser(user)}
                </option>
              ))}
            </Select>
          </Field>

          <StatGrid>
            <Stat
              label="Permissions in force"
              value={view.effective}
              hint="What the guards will actually allow"
              tone="primary"
            />
            <Stat
              label="From the role"
              value={view.fromRole}
              hint={view.user.roleLabel}
              tone="neutral"
            />
            <Stat
              label="Given on top"
              value={view.added}
              hint={view.added === 0 ? "Nothing added" : "Beyond what the role gives"}
              tone={view.added > 0 ? "warning" : "neutral"}
            />
            <Stat
              label="Taken away"
              value={view.removed}
              hint={view.removed === 0 ? "Nothing removed" : "Held back from the role"}
              tone={view.removed > 0 ? "warning" : "neutral"}
            />
          </StatGrid>

          <Alert tone="info" title="How this works">
            A role hands out a bundle of permissions. Anything you change here applies to this one
            person on top of that bundle, and it survives a change of role. Your own role is{" "}
            {actorRoleLabel}: you may adjust anybody junior to you, never yourself, and you can never
            give away a permission you do not hold yourself — otherwise this screen would be a way of
            promoting yourself in two steps. Every change is written to the audit trail with your
            name on it.
          </Alert>

          {view.redundant > 0 ? (
            <Alert tone="info">
              {pluralise(view.redundant, "override")} here{" "}
              {view.redundant === 1 ? "says" : "say"} exactly what the {view.user.roleLabel} role
              already says, so {view.redundant === 1 ? "it changes" : "they change"} nothing today.
              That is not a mistake: an override outlives a change of role, so it will still apply
              if {view.user.name} is moved to a role that gives something different.
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-end justify-between gap-3">
            <Field label="Find a permission" htmlFor="permissionSearch">
              <Input
                id="permissionSearch"
                className="w-64"
                placeholder="payroll, documents, approve…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </Field>
            {/* The accessible name repeats the visible text rather than
                improving on it: somebody driving this by voice says what they
                can see, and a cleverer aria-label is a control they cannot ask
                for by name. */}
            <label className="flex items-center gap-2 pb-2.5 text-sm" htmlFor="onlyChanged">
              <Switch
                id="onlyChanged"
                checked={onlyChanged}
                onCheckedChange={setOnlyChanged}
                aria-label="Only what has been changed"
              />
              Only what has been changed
            </label>
          </div>
        </div>
      </Section>

      {groups.length === 0 ? (
        <Section title="Permissions" description="Nothing matches the current filter.">
          <EmptyState
            icon={Search}
            title="No permission matches"
            description={
              onlyChanged
                ? `${view.user.name} has nothing set that differs from the ${view.user.roleLabel} role. Switch the filter off to see the full list.`
                : "Try a different word, or clear the search."
            }
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery("");
                  setOnlyChanged(false);
                }}
              >
                Clear the filters
              </Button>
            }
          />
        </Section>
      ) : null}

      {groups.map((group) => (
        <Section key={group.key} title={group.title} description={group.description}>
          <ResponsiveList
            items={group.rows}
            head={
              <>
                <TH>Permission</TH>
                <TH>By role</TH>
                <TH>In force</TH>
                <TH>For this person</TH>
              </>
            }
            row={(row) => (
              <TR key={row.permission}>
                <TD className="max-w-md">
                  <PermissionLabel row={row} scope="table" />
                </TD>
                <TD className="whitespace-nowrap text-xs text-muted-foreground">
                  {row.fromRole ? "Included" : "Not included"}
                </TD>
                <TD>
                  <InForce row={row} />
                </TD>
                <TD>
                  <Control row={row} scope="table" busy={busy !== null} onChoose={choose} />
                </TD>
              </TR>
            )}
            card={(row) => (
              <div className="space-y-2">
                <PermissionLabel row={row} scope="card" />
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{row.fromRole ? "Included by role" : "Not in the role"}</span>
                  <InForce row={row} />
                </div>
                <Control row={row} scope="card" busy={busy !== null} onChoose={choose} />
              </div>
            )}
            empty={<EmptyState title="Nothing here" />}
          />
        </Section>
      ))}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent>
          {confirming ? (
            <>
              <DialogHeader>
                <DialogTitle>Give {view.user.name} this permission?</DialogTitle>
                <DialogDescription>{confirming.row.label}</DialogDescription>
              </DialogHeader>
              <DialogBody className="space-y-3 text-sm">
                <p>{confirming.row.description}</p>
                <Alert tone="warning" title="This is one of the ones that matters">
                  {confirming.row.fromRole
                    ? `The ${view.user.roleLabel} role includes this, and it is currently held back from ${view.user.name}. Letting the role apply again gives it straight back.`
                    : `The ${view.user.roleLabel} role does not include this. ${view.user.name} will have it until somebody takes it away, even if their role changes.`}
                </Alert>
              </DialogBody>
              <DialogFooter>
                <Button variant="secondary" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
                <Button
                  loading={busy === confirming.row.permission}
                  onClick={() => void apply(confirming.row, confirming.value)}
                >
                  Yes, give this
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * `ResponsiveList` renders both the table and the card list and hides one with
 * CSS, so every element in here exists twice. The scope prefix is what keeps the
 * ids unique — without it `aria-labelledby` on the card control resolves to the
 * table copy, and half the page is invalid HTML.
 */
type Scope = "table" | "card";

function PermissionLabel({ row, scope }: { row: PermissionRow; scope: Scope }) {
  return (
    <>
      <span className="flex flex-wrap items-center gap-1.5">
        <span id={`${scope}-${row.permission}-label`} className="text-sm font-medium">
          {row.label}
        </span>
        {row.sensitive ? <Badge tone="warning">high authority</Badge> : null}
      </span>
      <span
        id={`${scope}-${row.permission}-desc`}
        className="mt-0.5 block text-xs text-muted-foreground"
      >
        {row.description}
      </span>
    </>
  );
}

/** The answer the guards will give, and where it came from. */
function InForce({ row }: { row: PermissionRow }) {
  const note = overrideNote(row);
  return (
    <span className="flex flex-col items-start gap-1">
      <Badge tone={row.effective ? "success" : "neutral"}>{row.effective ? "Yes" : "No"}</Badge>
      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
    </span>
  );
}

function Control({
  row,
  scope,
  busy,
  onChoose,
}: {
  row: PermissionRow;
  scope: Scope;
  busy: boolean;
  onChoose: (row: PermissionRow, value: PermissionValue) => void;
}) {
  return (
    <span className="flex flex-col items-start gap-1">
      <Select
        className="w-44"
        value={currentValue(row)}
        disabled={busy}
        aria-labelledby={`${scope}-${row.permission}-label`}
        aria-describedby={`${scope}-${row.permission}-desc`}
        onChange={(e) => onChoose(row, e.target.value as PermissionValue)}
      >
        {VALUES.map((value) => (
          <option key={value} value={value} disabled={!row.allowed.includes(value)}>
            {VALUE_LABELS[value]}
          </option>
        ))}
      </Select>
      {row.restriction ? (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Lock className="size-3" role="img" aria-label="You cannot give this one" />
          Yours to take away only
        </span>
      ) : null}
    </span>
  );
}

function currentValue(row: PermissionRow): PermissionValue {
  return row.override ?? "inherit";
}

/** Why the answer in the "in force" column is what it is. */
function overrideNote(row: PermissionRow): string | null {
  if (row.override === null) return null;
  if (row.override === "grant") {
    return row.fromRole ? "kept, whatever the role becomes" : "given to this person";
  }
  return row.fromRole ? "taken away from this person" : "held back, though the role never gave it";
}

function describeUser(user: UserSummary): string {
  const changes = user.added + user.removed;
  const parts = [user.roleLabel];
  if (user.status !== "ACTIVE") parts.push(user.status.toLowerCase());
  if (changes > 0) parts.push(`${changes} adjusted`);
  return `${user.name} — ${parts.join(" · ")}`;
}
