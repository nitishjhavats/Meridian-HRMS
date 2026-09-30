"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, MonitorSmartphone, Smartphone, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import {
  describeArrivals,
  safeParseAttendancePolicy,
  shiftMinutes,
  STATUS_LABELS,
  type AttendancePolicy,
} from "@/domain/attendance/policy";
import type { FaceMatchPolicy } from "@/domain/attendance/faceMatch";

/**
 * The organisation's attendance rules.
 *
 * The thresholds on this screen interact, and a bad combination does not throw —
 * it silently mis-scores everybody's day for a month. So two things happen here
 * that an ordinary settings form does not do:
 *
 *   - it validates with the *same* schema the server enforces, as you type, so a
 *     refusal arrives before you have filled in eight more fields;
 *   - it shows what the current numbers actually do, computed with the same
 *     `evaluateDay` that scores the real day, because "late after 15, half day
 *     after 30" is four interacting numbers and what an admin wants to know is
 *     what happens to somebody who walks in at 9:20.
 */

export interface AttendanceSettingsData {
  policy: AttendancePolicy;
  faceMatch: FaceMatchPolicy;
  shiftMinutes: number;
  effectiveFrom: string;
  /** Active employees with nothing to measure their coordinates against. */
  withoutWorkLocation?: { total: number; names: string[] };
}

export function AttendanceSettingsForm({
  initial,
  canWrite,
}: {
  initial: AttendanceSettingsData;
  canWrite: boolean;
}) {
  const router = useRouter();
  const withoutWorkLocation = initial.withoutWorkLocation ?? { total: 0, names: [] };
  const [policy, setPolicy] = useState<AttendancePolicy>(initial.policy);
  const [faceMatch, setFaceMatch] = useState<FaceMatchPolicy>(initial.faceMatch);
  const [effectiveFrom, setEffectiveFrom] = useState(initial.effectiveFrom);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof AttendancePolicy>(key: K, value: AttendancePolicy[K]) {
    setPolicy((p) => ({ ...p, [key]: value }));
  }

  // Validated with the server's own schema, so what you see here is what it will
  // say — there is no second, more forgiving copy of the rules in the browser.
  const validation = useMemo(() => safeParseAttendancePolicy(policy), [policy]);

  // "after 2 tries" / "after 1 try" / "the first time" -- read from the box
  // below rather than written into three sentences by hand.
  const triesCopy =
    faceMatch.retriesBeforeReview === 0
      ? "the first time"
      : `after ${faceMatch.retriesBeforeReview} ${faceMatch.retriesBeforeReview === 1 ? "try" : "tries"}`;

  const issues = useMemo(() => {
    const map = new Map<string, string>();
    if (validation.success) return map;
    for (const issue of validation.error.issues) {
      const path = issue.path.join(".");
      if (!map.has(path)) map.set(path, issue.message);
    }
    return map;
  }, [validation]);

  const examples = useMemo(() => {
    if (!validation.success) return [];
    try {
      return describeArrivals(validation.data as AttendancePolicy);
    } catch {
      return [];
    }
  }, [validation]);

  const nominal = useMemo(() => {
    try {
      return shiftMinutes(policy).duration;
    } catch {
      return 0;
    }
  }, [policy]);

  const kioskWithoutFace = policy.marking.kiosk && faceMatch.mode === "OFF";
  const canSave = canWrite && validation.success && !kioskWithoutFace && !saving;

  async function save() {
    setSaving(true);
    const result = await mutate(
      () =>
        api<AttendanceSettingsData>("/api/settings/attendance", {
          method: "PUT",
          body: { policy, faceMatch, effectiveFrom },
        }),
      { success: "Attendance rules saved.", error: "The rules were not saved" },
    );
    setSaving(false);
    if (result) {
      setPolicy(result.policy);
      setFaceMatch(result.faceMatch);
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      {!canWrite ? (
        <Alert tone="info" title="You can see these rules but not change them">
          Changing attendance rules needs the attendance settings permission.
        </Alert>
      ) : null}

      <Section
        title="Where attendance may be marked"
        description="Personal phones, the shared office device, or both."
      >
        <div className="divide-y divide-border">
          <Row
            icon={<Smartphone className="size-4" aria-hidden />}
            title="Employees' own devices"
            description="Each person marks their own attendance, signed in as themselves, inside your geofence."
          >
            <Switch
              checked={policy.marking.self}
              disabled={!canWrite}
              aria-label="Allow marking from personal devices"
              onCheckedChange={(v) => set("marking", { ...policy.marking, self: v })}
            />
          </Row>

          <Row
            icon={<MonitorSmartphone className="size-4" aria-hidden />}
            title="A shared office device"
            description="A screen you leave in the office. People tap their name and their face is checked against the photo on file."
          >
            <Switch
              checked={policy.marking.kiosk}
              disabled={!canWrite}
              aria-label="Allow marking on the office device"
              onCheckedChange={(v) => set("marking", { ...policy.marking, kiosk: v })}
            />
          </Row>
        </div>

        <div className="space-y-2 border-t border-border p-4">
          {issues.has("marking") ? <Alert tone="danger">{issues.get("marking")}</Alert> : null}

          {kioskWithoutFace ? (
            <Alert tone="danger" title="The office device needs face verification">
              On a shared screen the face is the only thing identifying who is marking
              attendance. Switch face verification on below, or turn the office device off.
            </Alert>
          ) : null}

          {!policy.marking.self ? (
            <Alert tone="warning" title="Field staff will need an exception">
              Nobody can mark from their own phone. Anyone who cannot reach the office device
              — sales, delivery, site staff — needs to be excepted individually on their
              employee record, or they will not be able to mark attendance at all.
            </Alert>
          ) : null}
        </div>
      </Section>

      <Section
        title="What counts as a full day"
        description={`Your shift is ${policy.shift.start} to ${policy.shift.end} with a ${policy.shift.breakMinutes}-minute break, so ${nominal} working minutes.`}
      >
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-4 sm:grid-cols-2">
          <Clock
            label="Shift starts"
            value={policy.shift.start}
            disabled={!canWrite}
            error={issues.get("shift.start")}
            onChange={(v) => set("shift", { ...policy.shift, start: v })}
          />
          <Clock
            label="Shift ends"
            value={policy.shift.end}
            disabled={!canWrite}
            error={issues.get("shift.end")}
            onChange={(v) => set("shift", { ...policy.shift, end: v })}
          />
          <Num
            label="Break"
            unit="minutes"
            value={policy.shift.breakMinutes}
            disabled={!canWrite}
            error={issues.get("shift.breakMinutes")}
            onChange={(v) => set("shift", { ...policy.shift, breakMinutes: v })}
            hint="Taken out of the working day before any threshold is applied."
          />
          <Num
            label="Grace period"
            unit="minutes"
            value={policy.graceMinutes}
            disabled={!canWrite}
            error={issues.get("graceMinutes")}
            onChange={(v) => set("graceMinutes", v)}
            hint="Arrive within this and you are on time."
          />
          <Num
            label="Late after"
            unit="minutes"
            value={policy.lateAfterMinutes}
            disabled={!canWrite}
            error={issues.get("lateAfterMinutes")}
            onChange={(v) => set("lateAfterMinutes", v)}
            hint="Past shift start, the day is flagged late."
          />
          <Num
            label="Half day after"
            unit="minutes"
            value={policy.halfDayAfterMinutes}
            disabled={!canWrite}
            error={issues.get("halfDayAfterMinutes")}
            onChange={(v) => set("halfDayAfterMinutes", v)}
            hint="Arrive later than this and it is a half day however long you stay."
          />
          <Num
            label="Early leave before"
            unit="minutes"
            value={policy.earlyLeaveBeforeMinutes}
            disabled={!canWrite}
            error={issues.get("earlyLeaveBeforeMinutes")}
            onChange={(v) => set("earlyLeaveBeforeMinutes", v)}
            hint="Leaving this far before shift end counts as an early departure."
          />
          <Num
            label="A full day needs"
            unit="minutes worked"
            value={policy.minMinutesFullDay}
            disabled={!canWrite}
            error={issues.get("minMinutesFullDay")}
            onChange={(v) => set("minMinutesFullDay", v)}
            hint={`Keep this below the ${nominal} minutes the shift itself is worth.`}
          />
          <Num
            label="A half day needs"
            unit="minutes worked"
            value={policy.minMinutesHalfDay}
            disabled={!canWrite}
            error={issues.get("minMinutesHalfDay")}
            onChange={(v) => set("minMinutesHalfDay", v)}
            hint="Below this, the day is absent."
          />
          <Num
            label="Extra day needs"
            unit="minutes worked"
            value={policy.extraDayMinMinutes}
            disabled={!canWrite}
            error={issues.get("extraDayMinMinutes")}
            onChange={(v) => set("extraDayMinMinutes", v)}
            hint="Work on a week off or holiday counts as an extra day past this."
          />

          <div className="sm:col-span-2">
            <p className="mb-1 text-xs font-medium">If somebody never checks out</p>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["IGNORE", "Score it on the check-in alone"],
                  ["HALF_DAY", "Make it a half day"],
                  ["ABSENT", "Make it absent"],
                ] as const
              ).map(([option, label]) => (
                <button
                  key={option}
                  type="button"
                  disabled={!canWrite}
                  onClick={() => set("missingCheckout", option)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    policy.missingCheckout === option
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card hover:bg-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {examples.length > 0 ? (
          <div className="border-t border-border p-4">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Info className="size-3.5" aria-hidden />
              With these rules, somebody who arrives at
            </p>
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
              {examples.map((example) => (
                <li
                  key={example.arrival}
                  className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2"
                >
                  <span className="tabular text-sm font-medium">{example.arrival}</span>
                  <Badge
                    tone={
                      example.status === "FULL_DAY"
                        ? "success"
                        : example.status === "HALF_DAY"
                          ? "warning"
                          : example.status === "ABSENT"
                            ? "danger"
                            : "neutral"
                    }
                  >
                    {STATUS_LABELS[example.status as keyof typeof STATUS_LABELS] ?? example.status}
                  </Badge>
                  {example.lateMinutes > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {example.lateMinutes} min late
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section title="Location and selfie" description="What is required at the moment of marking.">
        <div className="divide-y divide-border">
          <Row
            title="Require location"
            description="Refuse a mark from outside the work location's radius."
          >
            <Switch
              checked={policy.requireGps}
              disabled={!canWrite}
              aria-label="Require location"
              onCheckedChange={(v) => set("requireGps", v)}
            />
          </Row>
          <Row
            title="Require a work location"
            description="Refuse a mark from anybody who has no location to be measured against."
          >
            <Switch
              checked={policy.requireWorkLocation}
              disabled={!canWrite}
              aria-label="Require a work location"
              onCheckedChange={(v) => set("requireWorkLocation", v)}
            />
          </Row>
          <Row
            title="Require a selfie"
            description="Every mark carries a photo, kept for 60 days."
          >
            <Switch
              checked={policy.requireSelfie}
              disabled={!canWrite}
              aria-label="Require a selfie"
              onCheckedChange={(v) => set("requireSelfie", v)}
            />
          </Row>
          {/**
            * The accuracy gate, as a switch, off.
            *
            * It was a constant with no control: a third of the radius, capped
            * at 35 m, applied to every check-in. Measured on a live
            * organisation at a 300 m radius, it turned away people standing
            * at the counter whose phones could not do better than ±50 m, and
            * recorded nothing about the refusal. The distance is the fact
            * that matters; the accuracy is now stored with every mark and
            * shown beside it instead.
            */}
          <Row
            title="Require an accurate GPS fix"
            description="Off: only the distance to the branch decides. On: a reading coarser than the limit is refused. Older phones often cannot meet it."
          >
            <Switch
              checked={policy.gpsAccuracy.enforce}
              disabled={!canWrite}
              aria-label="Require an accurate GPS fix"
              onCheckedChange={(v) => set("gpsAccuracy", { ...policy.gpsAccuracy, enforce: v })}
            />
          </Row>
        </div>
        {withoutWorkLocation.total > 0 ? (
          <div className="border-t border-border p-4">
            <Alert
              tone={policy.requireWorkLocation ? "danger" : "warning"}
              title={`${withoutWorkLocation.total} ${
                withoutWorkLocation.total === 1 ? "person has" : "people have"
              } no work location`}
            >
              {policy.requireWorkLocation
                ? "They cannot mark attendance at all while this is on. Assign each of them a work location first."
                : "Requiring location does nothing for them: their coordinates are accepted and compared to nothing, so they can mark from anywhere."}{" "}
              {withoutWorkLocation.names.join(", ")}
              {withoutWorkLocation.total > withoutWorkLocation.names.length
                ? ` and ${withoutWorkLocation.total - withoutWorkLocation.names.length} more`
                : ""}
              .
            </Alert>
          </div>
        ) : null}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 p-4 sm:grid-cols-2">
          <Num
            label="Default radius"
            unit="metres"
            value={policy.defaultRadiusMeters}
            disabled={!canWrite}
            error={issues.get("defaultRadiusMeters")}
            onChange={(v) => set("defaultRadiusMeters", v)}
            hint="Used where a work location does not set its own."
          />
          <Num
            label="Accuracy limit"
            unit="metres"
            value={policy.gpsAccuracy.maxMeters}
            min={5}
            max={500}
            disabled={!canWrite || !policy.gpsAccuracy.enforce}
            error={issues.get("gpsAccuracy.maxMeters")}
            onChange={(v) => set("gpsAccuracy", { ...policy.gpsAccuracy, maxMeters: v })}
            hint={
              policy.gpsAccuracy.enforce
                ? "A phone reporting a wider circle than this is refused before the distance is measured."
                : "Only applies while the switch above is on. 35 m is a clear-sky satellite fix; indoors, most phones report 50 m or worse."
            }
          />
        </div>
      </Section>

      <Section
        title="Face verification"
        description="Whether the selfie is checked against the reference photo on the employee's profile."
      >
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["OFF", "Off"],
                ["ADVISORY", "Advisory"],
                ["REQUIRED", "Required"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={!canWrite}
                onClick={() => setFaceMatch((f) => ({ ...f, mode: value }))}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                  faceMatch.mode === value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card hover:bg-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            {faceMatch.mode === "OFF"
              ? "Selfies are stored but never compared."
              : faceMatch.mode === "ADVISORY"
                ? "A mismatch is recorded and flagged for review, but the person still marks their day. Safe to switch on before you trust the thresholds."
                : faceMatch.onMismatch === "REVIEW"
                  ? `Every photo is checked. Somebody whose face will not match ${triesCopy} can still mark, and it waits for you in the review queue.`
                  : "A mismatch refuses the mark outright, with no way through but a one-time PIN. Make sure everybody has a reference photo first."}
          </p>

          {policy.marking.kiosk ? (
            <Alert tone="info" title="The office device always requires a match">
              Whatever is chosen here, a mark made on the shared office device must pass the
              face check. On a personal phone the login already proves who you are; on a
              screen anyone can walk up to, it does not.
            </Alert>
          ) : null}

          <div className="divide-y divide-border rounded-lg border border-border">
            {/**
              * The two controls that decide whether somebody goes to work.
              *
              * Both fields have existed in the schema since face matching was
              * built and neither had a control anywhere in the product, so the
              * only way to change them was the settings API by hand. That is
              * how a blink check that refused sixteen of eighteen marks in one
              * morning stayed switched on: nobody could see it, so nobody could
              * turn it off.
              */}
            <Row
              title="Ask for a blink"
              description="Liveness, so a printed photo held up to the camera can be told from a person. It never blocks a mark: without one, the day is recorded and sent for review."
            >
              <Switch
                checked={faceMatch.requireBlink}
                disabled={!canWrite || faceMatch.mode === "OFF"}
                aria-label="Ask for a blink"
                onCheckedChange={(v) => setFaceMatch((f) => ({ ...f, requireBlink: v }))}
              />
            </Row>

            <Row
              title="Send a face that will not match to review"
              description={`On: ${
                faceMatch.retriesBeforeReview === 0
                  ? "the first mismatch is recorded straight away"
                  : `${triesCopy} the person may mark anyway`
              } and you decide from the photo. Off: the mark is refused, and a one-time PIN is the only way through.`}
            >
              <Switch
                checked={faceMatch.onMismatch === "REVIEW"}
                disabled={!canWrite || faceMatch.mode !== "REQUIRED"}
                aria-label="Send a mismatch to review"
                onCheckedChange={(v) =>
                  setFaceMatch((f) => ({ ...f, onMismatch: v ? "REVIEW" : "BLOCK" }))
                }
              />
            </Row>

            {/**
              * The number the switch above talks about.
              *
              * It was four, it was written in two sentences on this screen, and
              * it never ran: a mismatch under "review" took the mark on the
              * first try. Now it is a box, and the sentences read from it.
              */}
            <Row
              title="Tries before a mismatch goes to review"
              description="0 records the first mismatch at once. Each try is a fresh photo with a blink, so keep this small."
            >
              <NumberField
                className="w-20"
                value={faceMatch.retriesBeforeReview}
                disabled={!canWrite || faceMatch.mode !== "REQUIRED" || faceMatch.onMismatch !== "REVIEW"}
                aria-label="Tries before a mismatch goes to review"
                onValueChange={(v) =>
                  setFaceMatch((f) => ({ ...f, retriesBeforeReview: Math.max(0, Math.min(10, Math.round(v ?? 0))) }))
                }
              />
            </Row>

            <Row
              title="Refuse when there are several faces in shot"
              description="A second face in frame is how buddy-punching starts."
            >
              <Switch
                checked={faceMatch.rejectMultipleFaces}
                disabled={!canWrite}
                aria-label="Refuse multiple faces"
                onCheckedChange={(v) => setFaceMatch((f) => ({ ...f, rejectMultipleFaces: v }))}
              />
            </Row>

            <Row
              title="Block anyone without a reference photo"
              description="Otherwise they mark as normal and somebody is asked to enrol them."
            >
              <Switch
                checked={faceMatch.whenNotEnrolled === "BLOCK"}
                disabled={!canWrite}
                aria-label="Block employees with no reference photo"
                onCheckedChange={(v) =>
                  setFaceMatch((f) => ({ ...f, whenNotEnrolled: v ? "BLOCK" : "ALLOW" }))
                }
              />
            </Row>
          </div>
        </div>
      </Section>

      <div className="sticky bottom-3 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3 shadow-sm">
        <div className="min-w-0 flex-1">
          <label htmlFor="effective-from" className="block text-xs font-medium">
            Applies from
          </label>
          <Input
            id="effective-from"
            type="date"
            className="mt-1 max-w-[11rem]"
            value={effectiveFrom}
            min={initial.effectiveFrom}
            disabled={!canWrite}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Days already recorded keep the status they were given — they were scored under the
            rules in force at the time.
          </p>
        </div>

        {!validation.success ? (
          <p className="flex items-center gap-1.5 text-xs text-danger-text">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            Fix the highlighted fields first.
          </p>
        ) : null}

        <Button onClick={save} loading={saving} disabled={!canSave}>
          Save rules
        </Button>
      </div>
    </div>
  );
}

function Row({
  icon,
  title,
  description,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {icon ? <span className="shrink-0 text-primary">{icon}</span> : null}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Num({
  label,
  unit,
  value,
  hint,
  error,
  disabled,
  min,
  max,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  hint?: string;
  error?: string;
  disabled?: boolean;
  /** Clamped on blur by the field itself; the schema still says why while typing. */
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium">
        {label} <span className="font-normal text-muted-foreground">({unit})</span>
      </label>
      <NumberField
        className="mt-1"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        // Zero is a real setting for every one of these, and the ranges belong
        // to the schema validating as you type — not to the box, which should
        // let somebody clear it and start again.
        onValueChange={(v) => onChange(v ?? 0)}
      />
      {error ? (
        <p className="mt-1 text-xs text-danger-text">{error}</p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function Clock({
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  error?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium">{label}</label>
      <Input
        type="time"
        className="mt-1"
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <p className="mt-1 text-xs text-danger-text">{error}</p> : null}
    </div>
  );
}
