"use client";

import { useEffect, useState } from "react";
import { accuracyBudget } from "@/domain/attendance/geo";
import { DEFAULT_ATTENDANCE_POLICY } from "@/domain/attendance/policy";
import {
  Building2,
  ChevronDown,
  ChevronUp,
  Copy,
  Crosshair,
  MapPin,
  Plus,
  IdCard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { pluralise } from "@/lib/utils";

/**
 * Departments, designations and the places people work.
 *
 * `org.structure.manage` was declared, granted to Admins, and gated nothing —
 * the screens were never built. Everything else assumed they existed: the
 * employee form offers them, the spreadsheet importer matches them by name, and
 * a work location is what a kiosk stands at and what a geofence measures from.
 *
 * Nothing here deletes. A department with a year of payroll behind it is
 * switched off instead: it stops being offered and stays attached to everything
 * that already refers to it.
 */

interface Snapshot {
  departments: { id: string; name: string; code: string | null; active: boolean; employees: number }[];
  designations: {
    id: string;
    title: string;
    level: number;
    active: boolean;
    employees: number;
    reportsTo: { id: string; title: string; active: boolean }[];
  }[];
  workLocations: {
    id: string;
    name: string;
    address: string | null;
    addressLine2: string | null;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    requireGps: boolean;
    requireSelfie: boolean;
    active: boolean;
    isPrimary: boolean;
    employees: number;
    kiosks: number;
  }[];
}

/**
 * The shipped fence, read from the policy rather than typed here.
 *
 * This form carried `150` in six places as its own fallback. When the
 * shipped default moved -- to 100, and then back to 150 once real check-ins
 * showed 100 was turning honest arrivals away -- the form would have gone on
 * offering its own number to
 * every new branch, and the two numbers that have to agree would have been
 * two numbers.
 */
const DEFAULT_RADIUS = DEFAULT_ATTENDANCE_POLICY.defaultRadiusMeters;

export function Structure({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  /** The branch whose rules the others are being copied from. */
  const [copyFrom, setCopyFrom] = useState("");

  const [department, setDepartment] = useState("");
  const [designation, setDesignation] = useState("");
  const [location, setLocation] = useState({
    name: "",
    address: "",
    addressLine2: "",
    latitude: "",
    longitude: "",
    radiusMeters: String(DEFAULT_RADIUS),
  });
  /**
   * The fix this device just took, and how good it was.
   *
   * A geofence seeded from a poor fix is worse than none: it refuses people
   * standing inside it, or accepts people who are nowhere near. So the accuracy
   * is shown, and a fix worse than the radius being set is refused rather than
   * quietly used.
   */
  const [fix, setFix] = useState<
    | { kind: "idle" }
    | { kind: "locating" }
    | { kind: "ready"; accuracy: number }
    | { kind: "failed"; message: string }
  >({ kind: "idle" });

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setFix({ kind: "failed", message: "This device cannot report its location." });
      return;
    }
    setFix({ kind: "locating" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        const budget = accuracyBudget(Number(location.radiusMeters) || DEFAULT_RADIUS);

        // A capture is refused rather than recorded when the device is only
        // guessing. This used to store the coordinates and then merely *say*
        // how accurate they were, so a Wi-Fi estimate a few hundred metres from
        // the office became the fence centre, and every later distance was an
        // honest measurement to the wrong point. That is the single best
        // explanation for a person standing outside and being told 65 m.
        //
        // This gate stays although the check-in gate is off by default: a
        // rough check-in is one mark, recorded with its accuracy for a
        // reviewer to weigh; a rough centre is wrong for every mark after it.
        if (Math.round(accuracy) > budget) {
          setFix({
            kind: "failed",
            message: `A fence centre needs a reading of ±${budget} m or better for a ${
              Number(location.radiusMeters) || DEFAULT_RADIUS
            } m fence, and this device is only sure to about ±${Math.round(accuracy)} m. Check-ins are only held to a limit if you switch one on under Attendance rules; the centre always is. Step outside, wait a few seconds and try again — or paste the coordinates from a map pin on the office.`,
          });
          return;
        }

        setLocation((l) => ({
          ...l,
          // Five decimals is about a metre. More is false precision from a
          // phone, and it makes the field look like it means something it does
          // not.
          latitude: latitude.toFixed(5),
          longitude: longitude.toFixed(5),
        }));
        setFix({ kind: "ready", accuracy: Math.round(accuracy) });
      },
      (err) => {
        setFix({
          kind: "failed",
          message:
            err.code === err.PERMISSION_DENIED
              ? "Location permission was refused. Allow it for this site and try again."
              : err.code === err.TIMEOUT
                ? "Getting a fix took too long. Try again near a window or outside."
                : "Your location could not be determined.",
        });
      },
      // Same options the check-in panel uses: a fresh, accurate fix matters far
      // more than a fast one when the result becomes a fence.
      { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
    );
  }

  async function load() {
    const result = await api<Snapshot>("/api/settings/structure").catch(() => null);
    if (result) setData(result);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(body: Record<string, unknown>, success: string) {
    setBusy(true);
    const done = await mutate(
      () => api("/api/settings/structure", { method: "POST", body }),
      { success, error: "Nothing was saved" },
    );
    setBusy(false);
    if (done) await load();
    return done;
  }

  const designations = data?.designations ?? [];

  /** Swaps a designation with its neighbour and sends the whole new order. */
  async function move(index: number, delta: number) {
    const next = [...designations];
    const target = index + delta;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    await save(
      { kind: "designation-order", orderedIds: next.map((d) => d.id) },
      "Order saved.",
    );
  }

  /**
   * One primary parent at a time, so the picker is a single select rather than
   * a set somebody has to reason about. Removing the old edge first means a
   * change is a change rather than an accumulation.
   */
  async function setReportsTo(designationId: string, currentId: string, nextId: string) {
    if (currentId === nextId) return;
    if (currentId) {
      const removed = await save(
        {
          kind: "designation-reporting",
          designationId,
          reportsToDesignationId: currentId,
          remove: true,
        },
        nextId ? "Updating…" : "Reporting line removed.",
      );
      if (!removed) return;
    }
    if (nextId) {
      await save(
        { kind: "designation-reporting", designationId, reportsToDesignationId: nextId },
        "Reporting line saved.",
      );
    }
  }

  return (
    <div className="space-y-4">
      <Section title="Departments" description="What people are grouped by, on the payroll register and in reports.">
        <div className="space-y-3 p-4">
          <List
            icon={Building2}
            rows={(data?.departments ?? []).map((d) => ({
              id: d.id,
              title: d.name + (d.code ? ` · ${d.code}` : ""),
              subtitle: pluralise(d.employees, "person"),
              active: d.active,
            }))}
            canWrite={canWrite}
            busy={busy}
            onToggle={(row, active) =>
              save(
                { kind: "department", id: row.id, name: row.title.split(" · ")[0], active },
                active ? "Switched on." : "Switched off.",
              )
            }
            empty="No departments yet."
          />

          {canWrite ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Add a department" htmlFor="newDept">
                <Input
                  id="newDept"
                  className="max-w-xs"
                  placeholder="Engineering"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                />
              </Field>
              <Button
                size="sm"
                disabled={department.trim().length < 2 || busy}
                onClick={async () => {
                  if (await save({ kind: "department", name: department.trim() }, "Department added.")) {
                    setDepartment("");
                  }
                }}
              >
                <Plus className="size-4" aria-hidden />
                Add
              </Button>
            </div>
          ) : null}
        </div>
      </Section>

      <Section
        title="Designations"
        description="Job titles, most senior first, and who each one reports to. The order is presentation; the reporting line is what routes a new hire's approvals."
      >
        <div className="space-y-3 p-4">
          {designations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No designations yet.</p>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {designations.map((d, index) => (
                <li key={d.id} className="space-y-2 px-3 py-2.5">
                  <div className="flex flex-wrap items-start gap-2">
                    {canWrite ? (
                      <div className="flex shrink-0 flex-col">
                        <button
                          type="button"
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                          disabled={busy || index === 0}
                          aria-label={`Move ${d.title} up`}
                          onClick={() => void move(index, -1)}
                        >
                          <ChevronUp className="size-4" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                          disabled={busy || index === designations.length - 1}
                          aria-label={`Move ${d.title} down`}
                          onClick={() => void move(index, 1)}
                        >
                          <ChevronDown className="size-4" aria-hidden />
                        </button>
                      </div>
                    ) : (
                      <IdCard className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {d.title}
                        {!d.active ? (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            switched off
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {pluralise(d.employees, "person")}
                        {d.reportsTo.length > 0
                          ? ` · reports to ${d.reportsTo.map((r) => r.title).join(", ")}`
                          : " · reports to nobody"}
                      </p>
                    </div>

                    {canWrite ? (
                      <Switch
                        checked={d.active}
                        disabled={busy}
                        aria-label={`${d.title} in use`}
                        onCheckedChange={(active) =>
                          void save(
                            { kind: "designation", id: d.id, title: d.title, active },
                            active ? "Switched on." : "Switched off.",
                          )
                        }
                      />
                    ) : null}
                  </div>

                  {canWrite ? (
                    <div className="flex flex-wrap items-center gap-2 pl-6">
                      <label
                        htmlFor={`reports-${d.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        Reports to
                      </label>
                      <Select
                        id={`reports-${d.id}`}
                        className="max-w-xs"
                        disabled={busy}
                        value={d.reportsTo[0]?.id ?? ""}
                        onChange={(e) => void setReportsTo(d.id, d.reportsTo[0]?.id ?? "", e.target.value)}
                      >
                        <option value="">Nobody — top of the chart</option>
                        {designations
                          .filter((other) => other.id !== d.id)
                          .map((other) => (
                            <option key={other.id} value={other.id}>
                              {other.title}
                              {other.active ? "" : " (switched off)"}
                            </option>
                          ))}
                      </Select>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          {canWrite ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Add a designation" htmlFor="newDesig">
                <Input
                  id="newDesig"
                  className="max-w-xs"
                  placeholder="Software Engineer"
                  value={designation}
                  onChange={(e) => setDesignation(e.target.value)}
                />
              </Field>
              <Button
                size="sm"
                disabled={designation.trim().length < 2 || busy}
                onClick={async () => {
                  if (await save({ kind: "designation", title: designation.trim() }, "Designation added.")) {
                    setDesignation("");
                  }
                }}
              >
                <Plus className="size-4" aria-hidden />
                Add
              </Button>
            </div>
          ) : null}
        </div>
      </Section>

      <Section
        title="Work locations"
        description="Where people check in from, and where an office device stands."
      >
        <div className="space-y-3 p-4">
          {data && data.workLocations.length === 0 ? (
            <Alert tone="info" title="No locations yet">
              Without one, attendance has no geofence to measure against and an office device has
              nowhere to report from.
            </Alert>
          ) : null}

          {/* Why this matters more than it looks: attendance is only ever
              measured against a branch somebody is actually on. An employee
              with none has their coordinates collected and never compared, so
              they can mark from anywhere. Every employee in this product had
              none until the default branch existed. */}
          {(data?.workLocations ?? []).length > 0 &&
          !(data?.workLocations ?? []).some((l) => l.isPrimary && l.active) ? (
            <Alert tone="warning" title="No default branch">
              Somebody added without a branch has no geofence at all — their
              attendance is accepted wherever they are. Mark one branch as the
              default and new employees join it automatically.
            </Alert>
          ) : null}

          {/**
            * Copying one branch's rules onto the others.
            *
            * Asked for after four branches had been set up by hand. What
            * travels is the *policy* -- the radius, whether a photo is
            * required, whether coordinates are -- because the same answer
            * usually belongs at every branch and typing it four times is four
            * chances to type it differently. What does not travel is the name,
            * the address and the pin, because those are what make a branch that
            * branch; copying them would leave two offices claiming one place.
            */}
          {canWrite && (data?.workLocations ?? []).length > 1 ? (
            <div className="space-y-2 rounded-lg border border-dashed border-border p-3">
              <p className="text-sm font-medium">Copy rules to other branches</p>
              <p className="text-xs text-muted-foreground">
                Takes the radius, the photo rule and the GPS rule from one branch and writes them
                onto the others. Names, addresses and map pins are left alone.
              </p>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <Field label="Copy from" htmlFor="copyRulesFrom">
                  <Select
                    id="copyRulesFrom"
                    value={copyFrom}
                    onChange={(e) => setCopyFrom(e.target.value)}
                  >
                    <option value="">Choose a branch</option>
                    {(data?.workLocations ?? []).map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} &mdash; {l.radiusMeters} m
                        {l.requireSelfie ? ", photo" : ""}
                        {l.requireGps ? ", GPS" : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  variant="secondary"
                  disabled={busy || !copyFrom}
                  onClick={() => {
                    const targets = (data?.workLocations ?? [])
                      .filter((l) => l.id !== copyFrom)
                      .map((l) => l.id);
                    void save(
                      { kind: "location-rules-copy", fromId: copyFrom, toIds: targets },
                      `Rules copied to ${pluralise(targets.length, "other branch", "other branches")}.`,
                    );
                  }}
                >
                  <Copy className="size-4" aria-hidden />
                  Copy to the rest
                </Button>
              </div>
            </div>
          ) : null}

          {(data?.workLocations ?? []).map((l) => (
            <div key={l.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <MapPin className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{l.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {l.latitude.toFixed(5)}, {l.longitude.toFixed(5)} · {l.radiusMeters} m radius ·{" "}
                    {pluralise(l.employees, "person")}
                    {l.kiosks > 0 ? ` · ${pluralise(l.kiosks, "office device")}` : ""}
                  </span>
                </span>
                {l.isPrimary ? <Badge tone="info">default branch</Badge> : null}
                {!l.active ? <Badge tone="neutral">off</Badge> : null}
                {canWrite && l.active && !l.isPrimary ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void save(
                        {
                          kind: "location",
                          id: l.id,
                          name: l.name,
                          address: l.address ?? undefined,
                          addressLine2: l.addressLine2 ?? undefined,
                          latitude: l.latitude,
                          longitude: l.longitude,
                          radiusMeters: l.radiusMeters,
                          requireGps: l.requireGps,
                          requireSelfie: l.requireSelfie,
                          active: true,
                          isPrimary: true,
                        },
                        `New employees now join ${l.name}.`,
                      )
                    }
                  >
                    Make default
                  </Button>
                ) : null}
                {canWrite ? (
                  <Switch
                    checked={l.active}
                    disabled={busy}
                    aria-label={`${l.name} active`}
                    onCheckedChange={(active) =>
                      void save(
                        {
                          kind: "location",
                          id: l.id,
                          name: l.name,
                          address: l.address ?? undefined,
                          addressLine2: l.addressLine2 ?? undefined,
                          latitude: l.latitude,
                          longitude: l.longitude,
                          radiusMeters: l.radiusMeters,
                          requireGps: l.requireGps,
                          requireSelfie: l.requireSelfie,
                          active,
                        },
                        active ? "Switched on." : "Switched off.",
                      )
                    }
                  />
                ) : null}
              </div>
            </div>
          ))}

          {canWrite ? (
            <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
              <p className="text-sm font-medium">Add a location</p>
              <p className="text-xs text-muted-foreground">
                Stand where the office is and use this device&rsquo;s own location, or open the
                office in a map, right-click the pin and copy the coordinates. Guessing them is
                worse than having none: a geofence in the wrong place refuses people who are
                standing inside it.
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || fix.kind === "locating"}
                  loading={fix.kind === "locating"}
                  onClick={useMyLocation}
                >
                  <Crosshair className="size-4" aria-hidden />
                  Use my current location
                </Button>
                {fix.kind === "ready" ? (
                  <span className="text-xs text-muted-foreground">
                    Captured to about {fix.accuracy} m — good enough for a{" "}
                    {Number(location.radiusMeters) || DEFAULT_RADIUS} m fence
                  </span>
                ) : null}
                {fix.kind === "failed" ? (
                  <span className="text-xs text-danger-text">{fix.message}</span>
                ) : null}
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
                <Field label="Name" htmlFor="locName">
                  <Input
                    id="locName"
                    placeholder="Patna Office"
                    value={location.name}
                    onChange={(e) => setLocation({ ...location, name: e.target.value })}
                  />
                </Field>
                <Field label="Address line 1" htmlFor="locAddress">
                  <Input
                    id="locAddress"
                    placeholder="Plot 12, Nx One, Sector 12"
                    value={location.address}
                    onChange={(e) => setLocation({ ...location, address: e.target.value })}
                  />
                </Field>
                {/* Two lines, because the reception screen now prints this and
                    a single wrapping line pushed the header taller every time
                    somebody typed a full address into it. */}
                <Field label="Address line 2" htmlFor="locAddress2">
                  <Input
                    id="locAddress2"
                    placeholder="Greater Noida West, 201306"
                    value={location.addressLine2}
                    onChange={(e) => setLocation({ ...location, addressLine2: e.target.value })}
                  />
                </Field>
                <Field label="Latitude" htmlFor="locLat">
                  <Input
                    id="locLat"
                    inputMode="decimal"
                    placeholder="25.60930"
                    value={location.latitude}
                    onChange={(e) => setLocation({ ...location, latitude: e.target.value })}
                  />
                </Field>
                <Field label="Longitude" htmlFor="locLng">
                  <Input
                    id="locLng"
                    inputMode="decimal"
                    placeholder="85.12350"
                    value={location.longitude}
                    onChange={(e) => setLocation({ ...location, longitude: e.target.value })}
                  />
                </Field>
                {location.latitude && location.longitude ? (
                  <div className="sm:col-span-2">
                    {/* Look at it before saving. Nothing in this form has ever
                        shown where the pin actually lands, and a fence centred
                        on a coordinate nobody checked measures honestly to the
                        wrong place for ever. */}
                    <a
                      className="text-xs underline underline-offset-2"
                      href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Check this pin on a map before saving
                    </a>
                  </div>
                ) : null}
                <Field label="Radius" htmlFor="locRadius" hint="Metres. Between 20 and 5000.">
                  <Input
                    id="locRadius"
                    type="number"
                    value={location.radiusMeters}
                    onChange={(e) => setLocation({ ...location, radiusMeters: e.target.value })}
                  />
                </Field>
              </div>
              <Button
                size="sm"
                disabled={
                  busy ||
                  location.name.trim().length < 2 ||
                  // A fix wider than the fence would refuse people at their own
                  // desks. Better to make somebody take it again.
                  (fix.kind === "ready" && fix.accuracy > (Number(location.radiusMeters) || DEFAULT_RADIUS))
                }
                onClick={async () => {
                  const done = await save(
                    {
                      kind: "location",
                      name: location.name.trim(),
                      address: location.address.trim() || undefined,
                      addressLine2: location.addressLine2.trim() || undefined,
                      latitude: Number(location.latitude),
                      longitude: Number(location.longitude),
                      radiusMeters: Number(location.radiusMeters) || DEFAULT_RADIUS,
                    },
                    "Location added.",
                  );
                  if (done) {
                    setLocation({
                      name: "",
                      address: "",
                      addressLine2: "",
                      latitude: "",
                      longitude: "",
                      radiusMeters: String(DEFAULT_RADIUS),
                    });
                    setFix({ kind: "idle" });
                  }
                }}
              >
                <Plus className="size-4" aria-hidden />
                Add location
              </Button>
            </div>
          ) : null}
        </div>
      </Section>
    </div>
  );
}

function List({
  icon: Icon,
  rows,
  canWrite,
  busy,
  onToggle,
  empty,
}: {
  icon: typeof Building2;
  rows: { id: string; title: string; subtitle: string; active: boolean }[];
  canWrite: boolean;
  busy: boolean;
  onToggle: (row: { id: string; title: string }, active: boolean) => void;
  empty: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center gap-3 px-3 py-2">
          <Icon className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{row.title}</span>
            <span className="block text-xs text-muted-foreground">{row.subtitle}</span>
          </span>
          {!row.active ? <Badge tone="neutral">off</Badge> : null}
          {canWrite ? (
            <Switch
              checked={row.active}
              disabled={busy}
              aria-label={`${row.title} active`}
              onCheckedChange={(active) => onToggle(row, active)}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
