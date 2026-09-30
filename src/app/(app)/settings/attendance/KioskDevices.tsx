"use client";

import { useEffect, useState } from "react";
import { MonitorSmartphone, Pencil, Trash2, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Section } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { checkPassword } from "@/domain/password";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CredentialHandover } from "@/components/auth/CredentialHandover";
import { formatRelative } from "@/lib/utils";

/**
 * The screens this organisation has standing in its offices.
 *
 * Creating one hands back a password exactly once. It is shown until dismissed
 * rather than toasted away, because somebody has to walk to a device and type
 * it, and a password that vanished after four seconds means starting again.
 */

type RosterScope = "ORGANISATION" | "WORK_LOCATION";

interface Device {
  id: string;
  label: string;
  email: string;
  workLocation: string;
  workLocationId: string;
  rosterScope: RosterScope;
  createdAt: string;
  lastSeenAt: string | null;
}

interface Payload {
  devices: Device[];
  locations: { id: string; name: string }[];
  /**
   * How many employees have no work location at all.
   *
   * Said at the point of choosing, because a device set to one branch lists
   * nobody who is not at a branch, and finding that out is otherwise a
   * receptionist telling somebody their name is missing.
   */
  withoutWorkLocation: number;
}

const SCOPE_LABEL: Record<RosterScope, string> = {
  WORK_LOCATION: "Only this location's employees",
  ORGANISATION: "Everybody in the organisation",
};

export function KioskDevices({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const [label, setLabel] = useState("");
  const [locationId, setLocationId] = useState("");
  // The form's default, not the column's. The column stays ORGANISATION so the
  // migration leaves the devices already standing in offices exactly as they
  // are; a new one is asked, and this is the answer offered first.
  const [scope, setScope] = useState<RosterScope>("WORK_LOCATION");
  const [editing, setEditing] = useState<Device | null>(null);
  const [draft, setDraft] = useState<{
    label: string;
    workLocationId: string;
    rosterScope: RosterScope;
  } | null>(null);
  const [created, setCreated] = useState<{
    label: string;
    email: string;
    password: string;
    signInUrl: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosingFor, setChoosingFor] = useState<Device | null>(null);
  const [chosen, setChosen] = useState("");
  const verdict = checkPassword(chosen);

  async function load() {
    const result = await api<Payload>("/api/settings/attendance/devices").catch(() => null);
    if (result) {
      setData(result);
      setLocationId((current) => current || (result.locations[0]?.id ?? ""));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ id: string; label: string; email: string; password: string; signInUrl: string }>(
          "/api/settings/attendance/devices",
          {
            method: "POST",
            body: { label: label.trim(), workLocationId: locationId, rosterScope: scope },
          },
        ),
      { error: "The device was not created" },
    );
    setBusy(false);
    if (result) {
      setCreated(result);
      setLabel("");
      void load();
    }
  }

  /**
   * Renaming a device, moving it, or changing who it lists.
   *
   * None of this was possible: the lifecycle was create, new password, revoke.
   * Moving a screen to another floor meant revoking it and creating another,
   * which mints a new login and a new password for a device somebody then has
   * to walk over to and sign in again.
   */
  async function saveEdit(device: Device, patch: Partial<Device>) {
    setBusy(true);
    const result = await mutate(
      () =>
        api<Device>(`/api/settings/attendance/devices/${device.id}`, {
          method: "PATCH",
          body: {
            label: patch.label ?? device.label,
            workLocationId: patch.workLocationId ?? device.workLocationId,
            rosterScope: patch.rosterScope ?? device.rosterScope,
          },
        }),
      { success: `${patch.label ?? device.label} updated.`, error: "Nothing changed" },
    );
    setBusy(false);
    if (result) {
      setEditing(null);
      void load();
    }
  }

  /**
   * A new password for a device already in service.
   *
   * The one shown at creation is never recoverable, so a forgotten password
   * used to mean revoking the device and creating another -- which changes its
   * identity and leaves whoever is standing at it looking at a signed-out
   * screen for a different reason.
   */
  async function regenerate(device: Device) {
    setBusy(true);
    const result = await mutate<{
      label: string;
      email: string;
      password: string;
      signInUrl: string;
    }>(
      () => api(`/api/settings/attendance/devices/${device.id}`, { method: "POST" }),
      { success: `New password for ${device.label}.`, error: "Nothing changed" },
    );
    setBusy(false);
    if (result) {
      setCreated(result);
      void load();
    }
  }

  /** The same endpoint, with a password the administrator typed. */
  async function setPassword(device: Device, password: string) {
    setBusy(true);
    const result = await mutate<{
      label: string;
      email: string;
      password: string;
      signInUrl: string;
    }>(
      () =>
        api(`/api/settings/attendance/devices/${device.id}`, {
          method: "POST",
          body: { password },
        }),
      { success: `Password set for ${device.label}.`, error: "Nothing changed" },
    );
    setBusy(false);
    if (result) {
      setChoosingFor(null);
      setChosen("");
      setCreated(result);
      void load();
    }
  }

  async function revoke(device: Device) {
    setBusy(true);
    const done = await mutate(
      () => api(`/api/settings/attendance/devices/${device.id}`, { method: "DELETE" }),
      { success: `${device.label} was taken out of service.`, error: "It was not revoked" },
    );
    setBusy(false);
    if (done !== null) void load();
  }

  return (
    <div id="devices" className="scroll-mt-4">
    <Section
      title="Office devices"
      description="Screens left in an office, which people mark attendance on by face."
    >
      <div className="space-y-4 p-4">
        {/**
          * The same panel every other new account gets.
          *
          * This was a hand-rolled block showing an email and a password and no
          * address -- so whoever carried the credentials to the device had to
          * already know where to type them. `CredentialHandover` carries the
          * organisation's own door with them, and its copy button puts all
          * three in the clipboard together.
          *
          * Still an alert that stays until dismissed rather than a dialog:
          * somebody has to walk to a device and type this, and a panel that
          * closes when they look away is a password they have to reissue.
          */}
        {created ? (
          <Alert tone="success" title={`${created.label} is ready`}>
            <span className="mt-2 block">
              <CredentialHandover
                credential={{
                  name: created.label,
                  email: created.email,
                  temporaryPassword: created.password,
                  signInUrl: created.signInUrl,
                }}
                title="Sign in on the device with these"
              />
            </span>
            <span className="mt-3 block">
              <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                I have written it down
              </Button>
            </span>
          </Alert>
        ) : null}

        {data && data.devices.length === 0 ? (
          <EmptyState
            icon={MonitorSmartphone}
            title="No office devices yet"
            description="Create one, sign in on the screen you want to leave in the office, and open /kiosk."
          />
        ) : null}

        {data && data.devices.length > 0 ? (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {data.devices.map((device) => (
              <li key={device.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <MonitorSmartphone className="size-4 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{device.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {device.workLocation} ·{" "}
                    {device.rosterScope === "WORK_LOCATION"
                      ? "this location only"
                      : "everybody"}{" "}
                    ·{" "}
                    {device.lastSeenAt
                      ? `last used ${formatRelative(device.lastSeenAt)}`
                      : "never used"}
                  </p>
                </div>
                {canWrite ? (
                  <div className="flex flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setEditing(device);
                        setDraft({
                          label: device.label,
                          workLocationId: device.workLocationId,
                          rosterScope: device.rosterScope,
                        });
                      }}
                    >
                      <Pencil className="size-4" aria-hidden />
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void regenerate(device)}
                    >
                      <KeyRound className="size-4" aria-hidden />
                      New password
                    </Button>
                    {/* Chosen, not generated. A generated password is stronger
                        and is what a device gets on day one; somebody standing
                        at a tablet with a two-line keyboard needs one they can
                        type, and refusing them writes the generated one on a
                        sticky note beside the screen. It goes through the same
                        strength rules either way. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setChoosingFor(device);
                        setChosen("");
                      }}
                    >
                      <Pencil className="size-4" aria-hidden />
                      Set a password
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void revoke(device)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {canWrite && data ? (
          data.locations.length === 0 ? (
            <Alert tone="warning" title="No work locations yet">
              A device has to stand somewhere — it is where the coordinates on every mark come
              from. Add a work location first.
            </Alert>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3">
                <Field label="Name it" htmlFor="deviceLabel" hint="Something you will recognise.">
                  <Input
                    id="deviceLabel"
                    placeholder="Reception iPad"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                  />
                </Field>
                <Field label="Where it stands" htmlFor="deviceLocation">
                  <Select
                    id="deviceLocation"
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                  >
                    {data.locations.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Who it lists"
                  htmlFor="deviceScope"
                  hint="You can change this later."
                >
                  <Select
                    id="deviceScope"
                    value={scope}
                    onChange={(e) => setScope(e.target.value as RosterScope)}
                  >
                    <option value="WORK_LOCATION">{SCOPE_LABEL.WORK_LOCATION}</option>
                    <option value="ORGANISATION">{SCOPE_LABEL.ORGANISATION}</option>
                  </Select>
                </Field>
              </div>

              {/* Said before the choice is made rather than discovered at a
                  reception desk. A device limited to one location lists nobody
                  who has not been given one. */}
              {scope === "WORK_LOCATION" && data.withoutWorkLocation > 0 ? (
                <Alert tone="warning" title="Some people have no work location">
                  {data.withoutWorkLocation === 1
                    ? "One employee has no work location set, so they will not appear on this device."
                    : `${data.withoutWorkLocation} employees have no work location set, so they will not appear on this device.`}{" "}
                  Set one on their profile, or choose {SCOPE_LABEL.ORGANISATION.toLowerCase()}.
                </Alert>
              ) : null}

              <Button
                loading={busy}
                disabled={label.trim().length < 2 || !locationId || busy}
                onClick={() => void create()}
              >
                Create device
              </Button>
            </div>
          )
        ) : null}
      </div>
    </Section>

      {/**
        * One dialog for the three things about a device that can change.
        *
        * They are one question -- which screen is this, where does it stand,
        * and who does it list -- and splitting them across three controls is
        * how a device ends up labelled Reception while listing the warehouse.
        */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setDraft(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {editing?.label}</DialogTitle>
            <DialogDescription>
              The device stays signed in. Its password and its login address do not change.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-3">
            <Field label="Name" htmlFor="editLabel">
              <Input
                id="editLabel"
                value={draft?.label ?? ""}
                onChange={(e) => setDraft((d) => (d ? { ...d, label: e.target.value } : d))}
              />
            </Field>
            <Field label="Where it stands" htmlFor="editLocation">
              <Select
                id="editLocation"
                value={draft?.workLocationId ?? ""}
                onChange={(e) =>
                  setDraft((d) => (d ? { ...d, workLocationId: e.target.value } : d))
                }
              >
                {(data?.locations ?? []).map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Who it lists" htmlFor="editScope">
              <Select
                id="editScope"
                value={draft?.rosterScope ?? "ORGANISATION"}
                onChange={(e) =>
                  setDraft((d) => (d ? { ...d, rosterScope: e.target.value as RosterScope } : d))
                }
              >
                <option value="WORK_LOCATION">{SCOPE_LABEL.WORK_LOCATION}</option>
                <option value="ORGANISATION">{SCOPE_LABEL.ORGANISATION}</option>
              </Select>
            </Field>

            {/* The same warning as the create form, for the same reason: this
                is the moment somebody disappears from a reception screen. */}
            {draft?.rosterScope === "WORK_LOCATION" && (data?.withoutWorkLocation ?? 0) > 0 ? (
              <Alert tone="warning" title="Some people have no work location">
                {data!.withoutWorkLocation === 1
                  ? "One employee has no work location set, so they will not appear on this device."
                  : `${data!.withoutWorkLocation} employees have no work location set, so they will not appear on this device.`}
              </Alert>
            ) : null}
          </DialogBody>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setDraft(null);
              }}
            >
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy || !draft || draft.label.trim().length < 2}
              onClick={() => editing && draft && void saveEdit(editing, draft)}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={choosingFor !== null} onOpenChange={(open) => !open && setChoosingFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set a password for {choosingFor?.label}</DialogTitle>
            <DialogDescription>
              Every session on that device is signed out, so somebody has to type this in on the
              screen itself before anybody can mark attendance there again.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Field
              label="New password"
              htmlFor="kioskPassword"
              required
              hint={
                verdict.problems[0] ??
                "Long enough to be safe, simple enough to type on a tablet keyboard."
              }
              error={chosen.length > 0 && !verdict.ok ? verdict.problems[0] : undefined}
            >
              <Input
                id="kioskPassword"
                type="text"
                autoComplete="off"
                className="font-mono"
                value={chosen}
                onChange={(e) => setChosen(e.target.value)}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setChoosingFor(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy || !verdict.ok}
              onClick={() => choosingFor && void setPassword(choosingFor, chosen)}
            >
              Set it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
