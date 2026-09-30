"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Pencil,
  Plus,
  Repeat,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Section } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import { cn, formatDate, formatDuration, pluralise } from "@/lib/utils";
import { MONTH_NAMES, dayOfWeek, daysInMonth, makeDate, parts } from "@/domain/date";
import {
  type RotatingRule,
  type WeeklyOffConfig,
  describeWeeklyOff,
  isWeeklyOff,
  validateWeeklyOffConfig,
} from "@/domain/calendar";
import type {
  CalendarSnapshot,
  HolidayRow,
  ShiftRow,
  WeeklyOffPatternRow,
} from "@/services/org/calendar";

/**
 * The three tables that decide what a day *is*.
 *
 * The weekly-off editor is the reason this screen exists. "2nd and 4th
 * Saturday" is a sentence anybody can say and nobody can verify by reading a
 * form — the rule is 1-based occurrences inside a month, so a January that
 * opens on a Saturday puts the 2nd occurrence on the 8th and the 4th on the
 * 22nd, and getting it wrong shows up months later as somebody marked absent.
 * So the month preview is not decoration: it runs the same `isWeeklyOff` that
 * scores attendance and counts payable days, over the actual dates, and shows
 * what comes out.
 *
 * `validateWeeklyOffConfig` runs here too, live, while somebody types. That is
 * a convenience, not the check — the service calls it again on the write path,
 * where it is the boundary.
 */

const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINALS = ["1st", "2nd", "3rd", "4th", "5th"];

/** How somebody describes their week-off, rather than the enum it is stored as. */
type PatternMode = "WEEKLY" | "ROTATIONAL" | "CUSTOM";

interface ShiftDraft {
  id?: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number | null;
  graceMinutes: number | null;
  crossesMidnight: boolean;
  isDefault: boolean;
  active: boolean;
}

interface PatternDraft {
  id?: string;
  name: string;
  mode: PatternMode;
  days: number[];
  rotating: RotatingRule[];
  dates: string[];
  isDefault: boolean;
  active: boolean;
}

export function CalendarSettings({ initial }: { initial: CalendarSnapshot }) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function save(body: Record<string, unknown>, success: string) {
    setBusy(true);
    const next = await mutate<CalendarSnapshot>(
      () => api("/api/settings/calendar", { method: "POST", body }),
      { success, error: "Nothing was saved" },
    );
    setBusy(false);
    if (next) {
      setData(next);
      router.refresh();
    }
    return next;
  }

  async function removeHoliday(holiday: HolidayRow) {
    setBusy(true);
    const next = await mutate<CalendarSnapshot>(
      () => api(`/api/settings/calendar/holidays/${holiday.id}`, { method: "DELETE" }),
      { success: `${holiday.name} removed.`, error: "Nothing was removed" },
    );
    setBusy(false);
    if (next) {
      setData(next);
      router.refresh();
    }
  }

  return (
    <div className="space-y-4">
      <Shifts data={data} busy={busy} onSave={save} />
      <WeeklyOffs data={data} busy={busy} onSave={save} />
      <Holidays data={data} busy={busy} onSave={save} onRemove={removeHoliday} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shifts                                                                     */
/* -------------------------------------------------------------------------- */

function Shifts({
  data,
  busy,
  onSave,
}: {
  data: CalendarSnapshot;
  busy: boolean;
  onSave: (body: Record<string, unknown>, success: string) => Promise<CalendarSnapshot | null>;
}) {
  const [draft, setDraft] = useState<ShiftDraft | null>(null);

  function edit(shift: ShiftRow) {
    setDraft({
      id: shift.id,
      name: shift.name,
      startTime: shift.startTime,
      endTime: shift.endTime,
      breakMinutes: shift.breakMinutes,
      graceMinutes: shift.graceMinutes,
      crossesMidnight: shift.crossesMidnight,
      isDefault: shift.isDefault,
      active: shift.active,
    });
  }

  async function submit() {
    if (!draft) return;
    const done = await onSave(
      {
        kind: "shift",
        id: draft.id,
        name: draft.name.trim(),
        startTime: draft.startTime,
        endTime: draft.endTime,
        breakMinutes: draft.breakMinutes ?? 0,
        graceMinutes: draft.graceMinutes ?? 0,
        crossesMidnight: draft.crossesMidnight,
        isDefault: draft.isDefault,
        // Carried from the row rather than assumed: editing a shift that is
        // switched off must not quietly switch it back on.
        active: draft.active,
      },
      draft.id ? "Shift saved." : "Shift added.",
    );
    if (done) setDraft(null);
  }

  return (
    <Section
      title="Shifts"
      description="The hours a person is expected for, recorded on their record and stamped on every attendance day."
      action={
        draft === null ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setDraft({
                name: "",
                startTime: "09:00",
                endTime: "18:00",
                breakMinutes: 60,
                graceMinutes: 10,
                crossesMidnight: false,
                isDefault: data.shifts.length === 0,
                active: true,
              })
            }
          >
            <Plus className="size-4" aria-hidden />
            New shift
          </Button>
        ) : null
      }
    >
      <div className="space-y-3 p-4">
        {/* Somebody comes here expecting to change when a person counts as late,
            and this is the wrong screen for it. Better said once, here, than
            discovered after editing a shift and watching nothing change. */}
        <Alert tone="info">
          A shift records the hours somebody is expected for. What counts as late, what earns a
          full day and when the check-in window opens are set once for the whole organisation
          in{" "}
          <Link href="/settings/attendance" className="font-medium underline underline-offset-2">
            attendance rules
          </Link>
          , not per shift.
        </Alert>

        {data.shifts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shifts yet.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {data.shifts.map((shift) => (
              <li key={shift.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Clock className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 break-words text-sm font-medium">{shift.name}</span>
                    {shift.isDefault ? <Badge tone="primary">default</Badge> : null}
                    {shift.crossesMidnight ? <Badge tone="outline">night</Badge> : null}
                    {!shift.active ? <Badge tone="neutral">off</Badge> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {shift.startTime}–{shift.endTime} · {shift.breakMinutes} min break ·{" "}
                    {formatDuration(shift.workingMinutes)} of work ·{" "}
                    {pluralise(shift.employees, "person", "people")}
                  </span>
                </span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(shift)}>
                  <Pencil className="size-4" aria-hidden />
                  Edit
                </Button>
                <Switch
                  checked={shift.active}
                  disabled={busy}
                  aria-label={`${shift.name} active`}
                  onCheckedChange={(active) =>
                    void onSave(
                      {
                        kind: "shift",
                        id: shift.id,
                        name: shift.name,
                        startTime: shift.startTime,
                        endTime: shift.endTime,
                        breakMinutes: shift.breakMinutes,
                        graceMinutes: shift.graceMinutes,
                        crossesMidnight: shift.crossesMidnight,
                        isDefault: shift.isDefault,
                        active,
                      },
                      active ? "Switched on." : "Switched off.",
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {draft ? (
          <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{draft.id ? "Edit shift" : "Add a shift"}</p>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                <X className="size-4" aria-hidden />
                Cancel
              </Button>
            </div>

            <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="shiftName">
                <Input
                  id="shiftName"
                  placeholder="General Shift"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field label="Break" htmlFor="shiftBreak" hint="Minutes, unpaid.">
                <NumberField
                  id="shiftBreak"
                  min={0}
                  value={draft.breakMinutes}
                  onValueChange={(breakMinutes) => setDraft({ ...draft, breakMinutes })}
                />
              </Field>
              <Field label="Starts" htmlFor="shiftStart">
                <Input
                  id="shiftStart"
                  type="time"
                  value={draft.startTime}
                  onChange={(e) => setDraft({ ...draft, startTime: e.target.value })}
                />
              </Field>
              <Field label="Ends" htmlFor="shiftEnd">
                <Input
                  id="shiftEnd"
                  type="time"
                  value={draft.endTime}
                  onChange={(e) => setDraft({ ...draft, endTime: e.target.value })}
                />
              </Field>
              <Field
                label="Grace"
                htmlFor="shiftGrace"
                hint="Minutes. Recorded on the shift; the rules that use it are organisation-wide."
              >
                <NumberField
                  id="shiftGrace"
                  min={0}
                  value={draft.graceMinutes}
                  onValueChange={(graceMinutes) => setDraft({ ...draft, graceMinutes })}
                />
              </Field>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.crossesMidnight}
                onCheckedChange={(crossesMidnight) => setDraft({ ...draft, crossesMidnight })}
              />
              Crosses midnight
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.isDefault}
                onCheckedChange={(isDefault) => setDraft({ ...draft, isDefault })}
              />
              Put new employees on this shift
            </label>

            <Button size="sm" disabled={busy || draft.name.trim().length < 2} onClick={submit}>
              {draft.id ? "Save shift" : "Add shift"}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Weekly offs                                                                */
/* -------------------------------------------------------------------------- */

function WeeklyOffs({
  data,
  busy,
  onSave,
}: {
  data: CalendarSnapshot;
  busy: boolean;
  onSave: (body: Record<string, unknown>, success: string) => Promise<CalendarSnapshot | null>;
}) {
  const [draft, setDraft] = useState<PatternDraft | null>(null);

  function edit(pattern: WeeklyOffPatternRow) {
    setDraft({
      id: pattern.id,
      name: pattern.name,
      mode:
        pattern.config.type === "CUSTOM"
          ? "CUSTOM"
          : pattern.config.type === "ROTATIONAL"
            ? "ROTATIONAL"
            : "WEEKLY",
      days: pattern.config.days ?? [],
      rotating: pattern.config.rotating ?? [],
      dates: pattern.config.dates ?? [],
      isDefault: pattern.isDefault,
      active: pattern.active,
    });
  }

  return (
    <Section
      title="Weekly offs"
      description="Which days of the week are off, including the ones that only come round on some weeks."
      action={
        draft === null ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              setDraft({
                name: "",
                mode: "WEEKLY",
                days: [0],
                rotating: [],
                dates: [],
                isDefault: data.patterns.length === 0,
                active: true,
              })
            }
          >
            <Plus className="size-4" aria-hidden />
            New pattern
          </Button>
        ) : null
      }
    >
      <div className="space-y-3 p-4">
        {data.patterns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No patterns yet.</p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {data.patterns.map((pattern) => (
              <li key={pattern.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Repeat className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 break-words text-sm font-medium">{pattern.name}</span>
                    {pattern.isDefault ? <Badge tone="primary">default</Badge> : null}
                    {!pattern.active ? <Badge tone="neutral">off</Badge> : null}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {pattern.summary} · {pluralise(pattern.employees, "person", "people")}
                  </span>
                </span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(pattern)}>
                  <Pencil className="size-4" aria-hidden />
                  Edit
                </Button>
                <Switch
                  checked={pattern.active}
                  disabled={busy}
                  aria-label={`${pattern.name} active`}
                  onCheckedChange={(active) =>
                    void onSave(
                      {
                        kind: "pattern",
                        id: pattern.id,
                        name: pattern.name,
                        config: pattern.config,
                        isDefault: pattern.isDefault,
                        active,
                      },
                      active ? "Switched on." : "Switched off.",
                    )
                  }
                />
              </li>
            ))}
          </ul>
        )}

        {/* Said here rather than left to be hunted for. `WeeklyOffConfig` has no
            notion of a half day and `DayKind` is WORKING | WEEK_OFF | HOLIDAY,
            so there is no option to find — only an absence to explain. */}
        <Alert tone="info" title="A half-day weekly off cannot be set here">
          A day is either working or off; there is nothing in between. An organisation that
          works Saturday mornings has to make Saturday a working day and reflect the shorter
          hours another way — a separate shift, or a half-day override on the attendance grid.
        </Alert>

        {draft ? (
          <PatternEditor
            draft={draft}
            setDraft={setDraft}
            today={data.today}
            busy={busy}
            onSave={onSave}
            onClose={() => setDraft(null)}
          />
        ) : null}
      </div>
    </Section>
  );
}

/** The draft's own shape turned into the thing `isWeeklyOff` actually reads. */
function toConfig(draft: PatternDraft): WeeklyOffConfig {
  if (draft.mode === "CUSTOM") return { type: "CUSTOM", dates: draft.dates };
  if (draft.mode === "ROTATIONAL") {
    return { type: "ROTATIONAL", days: draft.days, rotating: draft.rotating };
  }
  // FIXED and MULTIPLE differ only in how many days are picked, which is a
  // question the form can answer for somebody rather than asking it.
  return { type: draft.days.length > 1 ? "MULTIPLE" : "FIXED", days: draft.days };
}

function PatternEditor({
  draft,
  setDraft,
  today,
  busy,
  onSave,
  onClose,
}: {
  draft: PatternDraft;
  setDraft: (draft: PatternDraft) => void;
  today: string;
  busy: boolean;
  onSave: (body: Record<string, unknown>, success: string) => Promise<CalendarSnapshot | null>;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(() => {
    const { year, month } = parts(today);
    return { year, month };
  });
  const [newDate, setNewDate] = useState("");

  const config = useMemo(() => toConfig(draft), [draft]);
  // The same function the service calls. Live here for the person typing;
  // authoritative there, where it is the boundary.
  const problems = useMemo(() => validateWeeklyOffConfig(config), [config]);

  const preview = useMemo(() => {
    const total = daysInMonth(month.year, month.month);
    const dates = Array.from({ length: total }, (_, i) => makeDate(month.year, month.month, i + 1));
    return {
      leading: dayOfWeek(dates[0] ?? makeDate(month.year, month.month, 1)),
      days: dates.map((date) => ({ date, day: parts(date).day, off: isWeeklyOff(date, config) })),
    };
  }, [config, month]);

  const offDays = preview.days.filter((d) => d.off).length;

  function toggleDay(day: number) {
    setDraft({
      ...draft,
      days: draft.days.includes(day)
        ? draft.days.filter((d) => d !== day)
        : [...draft.days, day].sort((a, b) => a - b),
    });
  }

  function setRule(index: number, rule: RotatingRule) {
    setDraft({ ...draft, rotating: draft.rotating.map((r, i) => (i === index ? rule : r)) });
  }

  async function submit() {
    const done = await onSave(
      {
        kind: "pattern",
        id: draft.id,
        name: draft.name.trim(),
        config,
        isDefault: draft.isDefault,
        active: draft.active,
      },
      draft.id ? "Pattern saved." : "Pattern added.",
    );
    if (done) onClose();
  }

  return (
    <div className="space-y-4 rounded-lg border border-dashed border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{draft.id ? "Edit pattern" : "Add a pattern"}</p>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X className="size-4" aria-hidden />
          Cancel
        </Button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="patternName">
          <Input
            id="patternName"
            placeholder="Sunday and alternate Saturdays"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="Kind" htmlFor="patternMode">
          <Select
            id="patternMode"
            value={draft.mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as PatternMode })}
          >
            <option value="WEEKLY">The same days every week</option>
            <option value="ROTATIONAL">Some days only on certain weeks</option>
            <option value="CUSTOM">A list of specific dates</option>
          </Select>
        </Field>
      </div>

      {draft.mode !== "CUSTOM" ? (
        <div>
          <p className="mb-1.5 text-sm font-medium">Off every week</p>
          <div className="flex flex-wrap gap-1.5">
            {DAY_INITIALS.map((initial, day) => {
              const on = draft.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[day]}
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
        </div>
      ) : null}

      {draft.mode === "ROTATIONAL" ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Off on certain weeks only</p>
          <p className="text-xs text-muted-foreground">
            Week numbers are occurrences inside the month, which is how &ldquo;2nd and 4th
            Saturday&rdquo; is meant: the 2nd Saturday, not the Saturday of the 2nd week. A 5th
            occurrence only exists in some months.
          </p>

          {draft.rotating.map((rule, index) => (
            <div key={index} className="space-y-2 rounded-md border border-border p-2.5">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Day" htmlFor={`ruleDay${index}`}>
                  <Select
                    id={`ruleDay${index}`}
                    className="w-40"
                    value={String(rule.day)}
                    onChange={(e) => setRule(index, { ...rule, day: Number(e.target.value) })}
                  >
                    {DAY_NAMES.map((name, day) => (
                      <option key={day} value={day}>
                        {name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Which ones" htmlFor={`ruleBasis${index}`}>
                  <Select
                    id={`ruleBasis${index}`}
                    className="w-56"
                    value={rule.isoParity ?? "WEEKS"}
                    onChange={(e) =>
                      setRule(
                        index,
                        e.target.value === "WEEKS"
                          ? { day: rule.day, weeks: rule.weeks?.length ? rule.weeks : [2, 4] }
                          : { day: rule.day, isoParity: e.target.value as "ODD" | "EVEN" },
                      )
                    }
                  >
                    <option value="WEEKS">Chosen occurrences in the month</option>
                    <option value="ODD">Alternate weeks (odd ISO weeks)</option>
                    <option value="EVEN">Alternate weeks (even ISO weeks)</option>
                  </Select>
                </Field>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Remove this rule"
                  onClick={() =>
                    setDraft({ ...draft, rotating: draft.rotating.filter((_, i) => i !== index) })
                  }
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>

              {rule.isoParity ? null : (
                <div className="flex flex-wrap gap-1.5">
                  {ORDINALS.map((label, i) => {
                    const week = i + 1;
                    const on = rule.weeks?.includes(week) ?? false;
                    return (
                      <button
                        key={week}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setRule(index, {
                            day: rule.day,
                            weeks: on
                              ? (rule.weeks ?? []).filter((w) => w !== week)
                              : [...(rule.weeks ?? []), week].sort((a, b) => a - b),
                          })
                        }
                        className={cn(
                          "h-8 rounded-md border px-2.5 text-xs font-medium transition-colors",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-card text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}

          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              setDraft({ ...draft, rotating: [...draft.rotating, { day: 6, weeks: [2, 4] }] })
            }
          >
            <Plus className="size-4" aria-hidden />
            Add a rule
          </Button>
        </div>
      ) : null}

      {draft.mode === "CUSTOM" ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Off dates</p>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Add a date" htmlFor="customDate">
              <Input
                id="customDate"
                type="date"
                className="w-48"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
            </Field>
            <Button
              size="sm"
              variant="outline"
              disabled={!newDate || draft.dates.includes(newDate)}
              onClick={() => {
                setDraft({ ...draft, dates: [...draft.dates, newDate].sort() });
                setNewDate("");
              }}
            >
              <Plus className="size-4" aria-hidden />
              Add
            </Button>
          </div>
          {draft.dates.length === 0 ? (
            <p className="text-xs text-muted-foreground">No dates yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {draft.dates.map((date) => (
                <button
                  key={date}
                  type="button"
                  aria-label={`Remove ${formatDate(date)}`}
                  onClick={() =>
                    setDraft({ ...draft, dates: draft.dates.filter((d) => d !== date) })
                  }
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-xs hover:bg-muted"
                >
                  {formatDate(date)}
                  <X className="size-3" aria-hidden />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <div className="rounded-md bg-muted px-3 py-2 text-sm">
        <span className="text-muted-foreground">Reads as: </span>
        <span className="font-medium">{describeWeeklyOff(config)}</span>
      </div>

      {problems.length > 0 ? (
        <Alert tone="danger" title="This will not save">
          <ul className="list-disc space-y-0.5 pl-4">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {problems.length === 0 && offDays === preview.days.length ? (
        <Alert tone="danger" title="Every day in this month is off">
          Nobody on this pattern would ever have a working day, so they would be marked absent
          for ever and paid for no working days.
        </Alert>
      ) : null}

      <MonthPreview
        year={month.year}
        month={month.month}
        leading={preview.leading}
        days={preview.days}
        onMove={(delta) => {
          const total = month.year * 12 + (month.month - 1) + delta;
          setMonth({ year: Math.floor(total / 12), month: (total % 12) + 1 });
        }}
      />

      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={draft.isDefault}
          onCheckedChange={(isDefault) => setDraft({ ...draft, isDefault })}
        />
        Put new employees on this pattern
      </label>

      <Button
        size="sm"
        disabled={busy || draft.name.trim().length < 2 || problems.length > 0}
        onClick={submit}
      >
        {draft.id ? "Save pattern" : "Add pattern"}
      </Button>
    </div>
  );
}

/**
 * A month of real dates, each asked of `isWeeklyOff`.
 *
 * The point is that it is the same function, not a re-implementation of the
 * rule for display. If this grid and the attendance grid ever disagreed, the
 * preview would be worse than nothing.
 */
function MonthPreview({
  year,
  month,
  leading,
  days,
  onMove,
}: {
  year: number;
  month: number;
  leading: number;
  days: { date: string; day: number; off: boolean }[];
  onMove: (delta: number) => void;
}) {
  const offDays = days.filter((d) => d.off).length;

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {MONTH_NAMES[month - 1]} {year}
        </p>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" aria-label="Previous month" onClick={() => onMove(-1)}>
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button size="sm" variant="ghost" aria-label="Next month" onClick={() => onMove(1)}>
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {DAY_INITIALS.map((initial, day) => (
          <div key={day} className="pb-1 text-xs font-medium text-muted-foreground">
            {initial}
          </div>
        ))}
        {Array.from({ length: leading }, (_, i) => (
          <div key={`blank-${i}`} aria-hidden />
        ))}
        {days.map((day) => (
          <div
            key={day.date}
            className={cn(
              "rounded-md py-1.5 text-xs tabular-nums",
              day.off
                ? "bg-primary-muted font-semibold text-primary"
                : "text-muted-foreground",
            )}
          >
            {day.day}
          </div>
        ))}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {pluralise(offDays, "day")} off, {pluralise(days.length - offDays, "day")} working.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Holidays                                                                   */
/* -------------------------------------------------------------------------- */

function Holidays({
  data,
  busy,
  onSave,
  onRemove,
}: {
  data: CalendarSnapshot;
  busy: boolean;
  onSave: (body: Record<string, unknown>, success: string) => Promise<CalendarSnapshot | null>;
  onRemove: (holiday: HolidayRow) => void;
}) {
  const [year, setYear] = useState(data.years[0] ?? parts(data.today).year);
  const [form, setForm] = useState({
    name: "",
    date: "",
    type: "PUBLIC",
    paid: true,
    optional: false,
  });

  const shown = data.holidays.filter((h) => parts(h.date).year === year);

  async function submit() {
    const done = await onSave(
      {
        kind: "holiday",
        name: form.name.trim(),
        date: form.date,
        type: form.type,
        paid: form.paid,
        optional: form.optional,
      },
      "Holiday added.",
    );
    if (done) setForm({ name: "", date: "", type: "PUBLIC", paid: true, optional: false });
  }

  return (
    <Section
      title="Holidays"
      description="Days nobody is expected in. A holiday landing on a weekly off stays a weekly off, so it is never counted twice."
      action={
        <div className="flex gap-1">
          {data.years.map((y) => (
            <Button
              key={y}
              size="sm"
              variant={y === year ? "secondary" : "ghost"}
              onClick={() => setYear(y)}
            >
              {y}
            </Button>
          ))}
        </div>
      }
    >
      <ResponsiveList
        items={shown}
        empty={
          <EmptyState
            icon={CalendarDays}
            title={`No holidays in ${year}`}
            description="Until one is added, every working day in the year is expected to be worked."
          />
        }
        head={
          <>
            <TH>Holiday</TH>
            <TH>Date</TH>
            <TH>Kind</TH>
            <TH className="w-10" />
          </>
        }
        row={(holiday) => (
          <TR key={holiday.id}>
            <TD>
              <span className="font-medium">{holiday.name}</span>
              {holiday.note ? (
                <span className="block text-xs text-muted-foreground">{holiday.note}</span>
              ) : null}
            </TD>
            <TD>{formatDate(holiday.date)}</TD>
            <TD>
              <HolidayTags holiday={holiday} />
            </TD>
            <TD>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                aria-label={`Remove ${holiday.name}`}
                onClick={() => onRemove(holiday)}
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </TD>
          </TR>
        )}
        card={(holiday) => (
          <div className="flex items-start gap-3">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{holiday.name}</span>
              <span className="block text-xs text-muted-foreground">
                {formatDate(holiday.date)}
              </span>
              <span className="mt-1 flex flex-wrap gap-1">
                <HolidayTags holiday={holiday} />
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Remove ${holiday.name}`}
              onClick={() => onRemove(holiday)}
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </div>
        )}
      />

      <div className="space-y-3 border-t border-border p-4">
        <p className="text-sm font-medium">Add a holiday</p>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="holidayName">
            <Input
              id="holidayName"
              placeholder="Republic Day"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Date" htmlFor="holidayDate">
            <Input
              id="holidayDate"
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </Field>
          <Field label="Kind" htmlFor="holidayType">
            <Select
              id="holidayType"
              value={form.type}
              onChange={(e) =>
                setForm({
                  ...form,
                  type: e.target.value,
                  // Optional is what the calendar actually reads; keeping the two
                  // in step here means the form never shows one thing and stores
                  // another.
                  optional: e.target.value === "OPTIONAL" ? true : form.optional,
                })
              }
            >
              <option value="PUBLIC">Public</option>
              <option value="ORGANISATION">Organisation</option>
              <option value="REGIONAL">Regional</option>
              <option value="OPTIONAL">Optional</option>
            </Select>
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={form.paid}
            onCheckedChange={(paid) => setForm({ ...form, paid })}
          />
          Paid
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={form.optional}
            disabled={form.type === "OPTIONAL"}
            onCheckedChange={(optional) => setForm({ ...form, optional })}
          />
          Optional — offered, not given: the day stays a working day for anybody who does not
          take it
        </label>

        <Button
          size="sm"
          disabled={busy || form.name.trim().length < 2 || !form.date}
          onClick={submit}
        >
          <Plus className="size-4" aria-hidden />
          Add holiday
        </Button>
      </div>
    </Section>
  );
}

function HolidayTags({ holiday }: { holiday: HolidayRow }) {
  return (
    <>
      <Badge tone="outline">{holiday.type.toLowerCase()}</Badge>{" "}
      {holiday.optional ? <Badge tone="warning">optional</Badge> : null}{" "}
      {!holiday.paid ? <Badge tone="neutral">unpaid</Badge> : null}{" "}
      {holiday.restricted ? <Badge tone="info">some people only</Badge> : null}
    </>
  );
}
