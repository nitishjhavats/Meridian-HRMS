import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertSameTenant,
  hasPermission,
  requireAnyPermission,
  requireOrg,
  requireWrite,
} from "@/lib/auth/guard";
import { ConflictError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { formatDuration } from "@/lib/utils";
import {
  type DateOnly,
  DateError,
  addDays,
  assertDateOnly,
  eachDay,
  monthLabel,
  parts,
  todayInZone,
} from "@/domain/date";
import { DEFAULT_ATTENDANCE_POLICY, shiftMinutes } from "@/domain/attendance/policy";
import { holidayAnnouncement, shouldAnnounceHoliday } from "@/domain/org/holidayAnnouncement";
import { createAnnouncement } from "@/services/announcements";
import {
  type WeeklyOffConfig,
  type WeeklyOffType,
  describeWeeklyOff,
  isWeeklyOff,
  validateWeeklyOffConfig,
} from "@/domain/calendar";

/**
 * The working calendar: shifts, weekly-off patterns and holidays.
 *
 * These three tables decide what a day *is* before any attendance is looked at,
 * and until this screen existed every row in them was written once by
 * `provisionTenant` and never again. That left a real hole:
 * `validateWeeklyOffConfig` was called by nothing outside its own tests, so a
 * weekly-off configuration had never been checked on a write path — while
 * `isWeeklyOff` reads the same `config` in `attendance/record.ts` and
 * `payroll/inputBuilder.ts`. A malformed pattern therefore mis-scores
 * attendance and mis-counts payable days in silence, which is exactly the class
 * of bug nobody reports as a bug.
 *
 * Nothing here deletes a shift or a pattern. Both are stamped onto rows that
 * outlive them — `AttendanceDay.shiftId` records which shift a day was judged
 * against — so an unwanted one is switched off: it stops being offered for new
 * assignments and stays attached to everything that already refers to it. Same
 * reasoning as departments in `org/structure.ts`.
 */

export interface ShiftRow {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceMinutes: number;
  crossesMidnight: boolean;
  isDefault: boolean;
  active: boolean;
  employees: number;
  /** Nominal working minutes once the break is out. */
  workingMinutes: number;
}

export interface WeeklyOffPatternRow {
  id: string;
  name: string;
  type: WeeklyOffType;
  config: WeeklyOffConfig;
  /** `describeWeeklyOff` applied, so the list reads the way somebody says it. */
  summary: string;
  isDefault: boolean;
  active: boolean;
  employees: number;
}

export interface HolidayRow {
  id: string;
  name: string;
  date: DateOnly;
  type: string;
  paid: boolean;
  optional: boolean;
  note: string | null;
  /**
   * Limited to some departments, people or regions.
   *
   * This screen does not edit those lists — they are set by the importer and by
   * scripts — but it has to say when one is in force, or an administrator reads
   * "Ganesh Chaturthi" here and assumes everybody has it off.
   */
  restricted: boolean;
}

export interface CalendarSnapshot {
  shifts: ShiftRow[];
  patterns: WeeklyOffPatternRow[];
  holidays: HolidayRow[];
  /** The years the holiday list covers: this one and the next. */
  years: number[];
  today: DateOnly;
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

export async function getCalendar(ctx: AuthContext): Promise<CalendarSnapshot> {
  requireOrg(ctx);
  // Read, not write — the same reasoning as the attendance rules screen: being
  // able to see why a Saturday came out as a week off is useful to somebody who
  // may not change it, and every write below guards itself.
  //
  // Write counts as read here, and deliberately: per-user grants can revoke a
  // permission as well as add one, and every save returns the refreshed
  // calendar. Someone holding write with read revoked would otherwise make a
  // change that lands and then reads back as a refusal.
  requireAnyPermission(ctx, ["org.settings.read", "org.settings.write"]);

  const where = { organizationId: ctx.organizationId! };
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const year = parts(today).year;

  const [shifts, patterns, holidays] = await Promise.all([
    prisma.shift.findMany({
      where,
      select: {
        id: true,
        name: true,
        startTime: true,
        endTime: true,
        breakMinutes: true,
        graceMinutes: true,
        crossesMidnight: true,
        isDefault: true,
        active: true,
        _count: { select: { employees: true } },
      },
      orderBy: [{ active: "desc" }, { isDefault: "desc" }, { name: "asc" }],
    }),
    prisma.weeklyOffPattern.findMany({
      where,
      select: {
        id: true,
        name: true,
        type: true,
        config: true,
        isDefault: true,
        active: true,
        _count: { select: { employees: true } },
      },
      orderBy: [{ active: "desc" }, { isDefault: "desc" }, { name: "asc" }],
    }),
    // This year and the next. A holiday list is planned a year ahead and looked
    // back at while payroll for December is still open, so both are wanted.
    prisma.holiday.findMany({
      where: {
        ...where,
        date: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year + 1}-12-31`) },
      },
      orderBy: { date: "asc" },
    }),
  ]);

  return {
    shifts: shifts.map((s) => ({
      id: s.id,
      name: s.name,
      startTime: s.startTime,
      endTime: s.endTime,
      breakMinutes: s.breakMinutes,
      graceMinutes: s.graceMinutes,
      crossesMidnight: s.crossesMidnight,
      isDefault: s.isDefault,
      active: s.active,
      employees: s._count.employees,
      workingMinutes: workingMinutesOf(s),
    })),
    patterns: patterns.map((p) => {
      const config = readConfig(p.config, p.type);
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        config,
        summary: describeWeeklyOff(config),
        isDefault: p.isDefault,
        active: p.active,
        employees: p._count.employees,
      };
    }),
    holidays: holidays.map((h) => ({
      id: h.id,
      name: h.name,
      date: fromDbDate(h.date),
      type: h.type,
      paid: h.paid,
      optional: h.optional,
      note: h.note,
      restricted:
        h.departmentIds.length > 0 || h.employeeIds.length > 0 || h.regions.length > 0,
    })),
    years: [year, year + 1],
    today,
  };
}

/* -------------------------------------------------------------------------- */
/*  Shifts                                                                     */
/* -------------------------------------------------------------------------- */

export interface ShiftInput {
  id?: string;
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: number;
  graceMinutes?: number;
  crossesMidnight?: boolean;
  isDefault?: boolean;
  active?: boolean;
}

export async function saveShift(ctx: AuthContext, input: ShiftInput) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write", "attendance");

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the shift a name.");

  const crossesMidnight = input.crossesMidnight ?? false;
  const start = minutesOrThrow(input.startTime);
  const end = minutesOrThrow(input.endTime);

  // The two ways of writing a night shift disagree, and the disagreement is
  // silent: `shiftMinutes` adds a day when the flag is set *or* when the end is
  // not after the start. So 22:00–06:00 with the flag off is still read as a
  // night shift, and 09:00–18:00 with the flag on becomes a thirty-three hour
  // one. Refusing both makes the stored row mean what it says.
  if (!crossesMidnight && end <= start) {
    throw new ValidationError(
      `${input.endTime} is not after ${input.startTime}. Tick "crosses midnight" if this is a night shift.`,
    );
  }
  if (crossesMidnight && end > start) {
    throw new ValidationError(
      `${input.startTime} to ${input.endTime} ends the same day, so it does not cross midnight.`,
    );
  }

  const span = workingMinutesOf({
    startTime: input.startTime,
    endTime: input.endTime,
    breakMinutes: 0,
    crossesMidnight,
  });
  if (input.breakMinutes < 0 || input.breakMinutes >= span) {
    throw new ValidationError(
      `The shift is ${formatDuration(span)} long, so the break has to be shorter than that — otherwise there is no working time left in the day.`,
    );
  }

  const graceMinutes = input.graceMinutes ?? DEFAULT_ATTENDANCE_POLICY.graceMinutes;
  if (graceMinutes < 0 || graceMinutes > 240) {
    throw new ValidationError("Grace is between 0 and 240 minutes.");
  }

  const clash = await prisma.shift.findFirst({
    where: { organizationId: ctx.organizationId!, name, ...(input.id ? { NOT: { id: input.id } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`There is already a shift called ${name}.`);

  const active = input.active ?? true;
  let isDefault = input.isDefault ?? false;

  if (input.id) {
    const existing = await prisma.shift.findUnique({ where: { id: input.id } });
    assertSameTenant(ctx, existing, "That shift");
    // The default is what a new employee is put on. Switching it off would leave
    // the next joiner on a shift nobody may pick, so the default moves first.
    if (!active && (isDefault || existing!.isDefault)) {
      throw new ConflictError(
        `${name} is the default shift. Make another shift the default before switching this one off.`,
      );
    }
  }
  if (!active) isDefault = false;

  const data = {
    name,
    startTime: input.startTime,
    endTime: input.endTime,
    breakMinutes: input.breakMinutes,
    graceMinutes,
    crossesMidnight,
    isDefault,
    active,
  };

  const shift = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.shift.updateMany({
        where: {
          organizationId: ctx.organizationId!,
          isDefault: true,
          ...(input.id ? { NOT: { id: input.id } } : {}),
        },
        data: { isDefault: false },
      });
    }
    return input.id
      ? tx.shift.update({ where: { id: input.id }, data })
      : tx.shift.create({ data: { ...data, organizationId: ctx.organizationId! } });
  });

  await writeAudit(ctx, {
    action: input.id ? "shift.updated" : "shift.created",
    entityType: "Shift",
    entityId: shift.id,
    after: data,
  });

  return shift;
}

/* -------------------------------------------------------------------------- */
/*  Weekly-off patterns                                                        */
/* -------------------------------------------------------------------------- */

export interface WeeklyOffPatternInput {
  id?: string;
  name: string;
  config: WeeklyOffConfig;
  isDefault?: boolean;
  active?: boolean;
}

export async function saveWeeklyOffPattern(ctx: AuthContext, input: WeeklyOffPatternInput) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write", "attendance");

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the pattern a name.");

  const config = normaliseConfig(input.config);

  // The point of this whole service. `validateWeeklyOffConfig` has existed since
  // the domain was written and no write path had ever called it, so a pattern
  // with a weekday of 9, or a rotating rule with neither weeks nor a parity,
  // could be stored and then read straight into `isWeeklyOff` by attendance
  // scoring and payroll day-counting.
  const problems = validateWeeklyOffConfig(config);
  if (problems.length > 0) {
    throw new ValidationError(`That pattern will not work. ${problems.join(" ")}`, {
      issues: problems,
    });
  }

  if (leavesNoWorkingDay(config)) {
    throw new ConflictError(
      "Every day of the week is an off day in this pattern, so everybody on it would be marked absent for ever and paid for no working days. Leave at least one day working.",
    );
  }

  const clash = await prisma.weeklyOffPattern.findFirst({
    where: { organizationId: ctx.organizationId!, name, ...(input.id ? { NOT: { id: input.id } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`There is already a pattern called ${name}.`);

  const active = input.active ?? true;
  let isDefault = input.isDefault ?? false;

  if (input.id) {
    const existing = await prisma.weeklyOffPattern.findUnique({ where: { id: input.id } });
    assertSameTenant(ctx, existing, "That weekly-off pattern");
    if (!active && (isDefault || existing!.isDefault)) {
      throw new ConflictError(
        `${name} is the default pattern. Make another pattern the default before switching this one off.`,
      );
    }
  }
  if (!active) isDefault = false;

  // `type` is a column and also a field inside `config`, and `isWeeklyOff` reads
  // the one inside the JSON. They are written from the same value so a query on
  // the column can never disagree with what actually scores the day.
  const data = { name, type: config.type, config: config as unknown as object, isDefault, active };

  const pattern = await prisma.$transaction(async (tx) => {
    if (isDefault) {
      await tx.weeklyOffPattern.updateMany({
        where: {
          organizationId: ctx.organizationId!,
          isDefault: true,
          ...(input.id ? { NOT: { id: input.id } } : {}),
        },
        data: { isDefault: false },
      });
    }
    return input.id
      ? tx.weeklyOffPattern.update({ where: { id: input.id }, data })
      : tx.weeklyOffPattern.create({ data: { ...data, organizationId: ctx.organizationId! } });
  });

  await writeAudit(ctx, {
    action: input.id ? "weeklyoff.updated" : "weeklyoff.created",
    entityType: "WeeklyOffPattern",
    entityId: pattern.id,
    after: { name, type: config.type, config, isDefault, active },
    metadata: { summary: describeWeeklyOff(config) },
  });

  return pattern;
}

/* -------------------------------------------------------------------------- */
/*  Holidays                                                                   */
/* -------------------------------------------------------------------------- */

export interface HolidayInput {
  id?: string;
  name: string;
  date: DateOnly;
  type?: "PUBLIC" | "ORGANISATION" | "OPTIONAL" | "REGIONAL";
  paid?: boolean;
  optional?: boolean;
  note?: string;
}

export async function saveHoliday(ctx: AuthContext, input: HolidayInput) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write", "attendance");

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the holiday a name.");

  let date: DateOnly;
  try {
    date = assertDateOnly(input.date);
  } catch (error) {
    if (error instanceof DateError) throw new ValidationError("That is not a real date.");
    throw error;
  }

  const type = input.type ?? "PUBLIC";
  // `buildPeriodCalendar` decides whether a day is a holiday from the `optional`
  // flag and never looks at `type`. A row typed OPTIONAL with the flag clear
  // would therefore give everybody the day off — the opposite of what the person
  // choosing "optional" meant — so the flag follows the type rather than being
  // left to disagree with it.
  const optional = type === "OPTIONAL" ? true : (input.optional ?? false);

  await assertPayrollOpen(ctx.organizationId!, date, "Changing the holidays in");
  if (input.id) {
    const existing = await prisma.holiday.findUnique({ where: { id: input.id } });
    assertSameTenant(ctx, existing, "That holiday");
    const was = fromDbDate(existing!.date);
    if (was !== date) await assertPayrollOpen(ctx.organizationId!, was, "Moving a holiday out of");
  }

  const clash = await prisma.holiday.findFirst({
    where: {
      organizationId: ctx.organizationId!,
      name,
      date: toDbDate(date),
      ...(input.id ? { NOT: { id: input.id } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`${name} is already on the calendar for that day.`);

  const data = {
    name,
    date: toDbDate(date),
    type,
    paid: input.paid ?? true,
    optional,
    note: input.note?.trim() || null,
  };

  const holiday = input.id
    ? await prisma.holiday.update({ where: { id: input.id }, data })
    : await prisma.holiday.create({ data: { ...data, organizationId: ctx.organizationId! } });

  await writeAudit(ctx, {
    action: input.id ? "holiday.updated" : "holiday.created",
    entityType: "Holiday",
    entityId: holiday.id,
    after: { ...data, date },
  });

  // And tell everybody. Switching a holiday on from the suggested list has
  // announced since that screen was built; typing one in here announced
  // nothing -- so an organisation adding its own local festival, the one
  // holiday nobody else's calendar carries, got silence and half an office
  // turning up. Both paths go through `announceHoliday` now.
  await announceHoliday(ctx, {
    created: !input.id,
    name,
    date,
    optional,
  });

  return holiday;
}

/**
 * Posts the announcement a new holiday deserves.
 *
 * Best effort, and deliberately so: an announcement that cannot be posted --
 * the module is off, or this administrator does not hold the permission --
 * must not undo a holiday that has already been created and is already
 * correct. The calendar is the record; the announcement is the courtesy.
 *
 * `announcement.create` rather than the team-scoped variant: a holiday is the
 * whole organisation's, and somebody who may only address their own team
 * posting it to everybody would be a wider audience than their permission.
 */
export async function announceHoliday(
  ctx: AuthContext,
  holiday: { created: boolean; name: string; date: DateOnly; optional?: boolean; verify?: boolean },
): Promise<void> {
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  if (!shouldAnnounceHoliday({ created: holiday.created, date: holiday.date, today })) return;
  if (!ctx.modules.has("announcements") || !hasPermission(ctx, "announcement.create")) return;

  const { title, body } = holidayAnnouncement({
    name: holiday.name,
    date: holiday.date,
    ...(holiday.optional ? { optional: true } : {}),
    ...(holiday.verify ? { verify: true } : {}),
  });
  await createAnnouncement(ctx, { title, body, published: true }).catch(() => undefined);
}

/**
 * Holidays are the one thing here that is genuinely deleted.
 *
 * A shift and a pattern are stamped onto records that outlive them, so they are
 * switched off instead; a holiday is not referenced by anything — the calendar
 * is rebuilt from the table every time it is asked for. Which is also why a
 * closed payroll month is protected: removing a holiday from a month that has
 * already been approved would change the working days that month was calculated
 * from, without changing a rupee of what was actually paid.
 */
export async function deleteHoliday(ctx: AuthContext, id: string) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write", "attendance");

  const holiday = await prisma.holiday.findUnique({ where: { id } });
  assertSameTenant(ctx, holiday, "That holiday");

  const date = fromDbDate(holiday!.date);
  await assertPayrollOpen(ctx.organizationId!, date, "Removing a holiday from");

  await prisma.holiday.delete({ where: { id } });

  await writeAudit(ctx, {
    action: "holiday.deleted",
    entityType: "Holiday",
    entityId: id,
    before: {
      name: holiday!.name,
      date,
      type: holiday!.type,
      paid: holiday!.paid,
      optional: holiday!.optional,
    },
  });
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function toDbDate(date: DateOnly): Date {
  return new Date(`${assertDateOnly(date)}T00:00:00.000Z`);
}

/** `@db.Date` comes back as UTC midnight, so the first ten characters are the day. */
function fromDbDate(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

function minutesOrThrow(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) throw new ValidationError(`${time} is not a 24-hour time like 09:00 or 18:30.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The same arithmetic `shiftMinutes` uses, so this number and the scorer's agree. */
function workingMinutesOf(shift: {
  startTime: string;
  endTime: string;
  breakMinutes: number;
  crossesMidnight: boolean;
}): number {
  return shiftMinutes({
    shift: {
      start: shift.startTime,
      end: shift.endTime,
      breakMinutes: shift.breakMinutes,
      crossesMidnight: shift.crossesMidnight,
    },
  }).duration;
}

/**
 * A configuration with no working day left in it.
 *
 * Asked of the real `isWeeklyOff` rather than by inspecting the shape, because
 * a rotating rule can cover a weekday completely in more than one way — weeks
 * [1,2,3,4,5], or both parities on the same day — and the shape-reading version
 * of this check is the one that misses the second. A year, so a rule that only
 * bites in five-Saturday months is judged over months of every length.
 */
function leavesNoWorkingDay(config: WeeklyOffConfig): boolean {
  const from = "2001-01-01"; // A Monday, in a non-leap year; the span is what matters.
  return eachDay(from, addDays(from, 364)).every((date) => isWeeklyOff(date, config));
}

/**
 * Keeps only the fields the chosen type actually uses.
 *
 * Without this, switching a pattern from ROTATIONAL to FIXED leaves the old
 * rotating rules sitting in the JSON: inert, because `isWeeklyOff` only reads
 * them for ROTATIONAL, right up until somebody switches the type back and
 * silently resurrects rules they thought they had deleted. What is stored is
 * what is in force.
 */
function normaliseConfig(config: WeeklyOffConfig): WeeklyOffConfig {
  const unique = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

  if (config.type === "CUSTOM") {
    return { type: "CUSTOM", dates: [...new Set(config.dates ?? [])].sort() };
  }

  const days = unique(config.days ?? []);
  if (config.type === "ROTATIONAL") {
    return {
      type: "ROTATIONAL",
      days,
      rotating: (config.rotating ?? []).map((rule) => ({
        day: rule.day,
        ...(rule.weeks?.length ? { weeks: unique(rule.weeks) } : {}),
        ...(rule.isoParity ? { isoParity: rule.isoParity } : {}),
      })),
    };
  }
  return { type: config.type, days };
}

/**
 * A stored config is `Json`, so nothing guarantees it is still a valid one by
 * the time it is read — rows predating this screen were written by
 * `provisionTenant` and by the importer, neither of which validated. Reading it
 * back through the column's `type` keeps the snapshot honest rather than
 * casting and hoping.
 */
function readConfig(value: unknown, type: WeeklyOffType): WeeklyOffConfig {
  const raw = (value ?? {}) as Partial<WeeklyOffConfig>;
  return {
    type: raw.type ?? type,
    ...(Array.isArray(raw.days) ? { days: raw.days } : {}),
    ...(Array.isArray(raw.rotating) ? { rotating: raw.rotating } : {}),
    ...(Array.isArray(raw.dates) ? { dates: raw.dates } : {}),
  };
}

/**
 * Refuses a holiday change inside a payroll month that is already approved or
 * locked. The money is in `PayrollItem` rows and would not move, which is the
 * problem: the calendar the run was calculated from would no longer be the
 * calendar anybody can see.
 */
async function assertPayrollOpen(organizationId: string, date: DateOnly, what: string): Promise<void> {
  const { year, month } = parts(date);
  const run = await prisma.payrollRun.findFirst({
    where: {
      organizationId,
      periodYear: year,
      periodMonth: month,
      status: { in: ["APPROVED", "LOCKED"] },
    },
    select: { status: true },
  });
  if (!run) return;

  throw new ConflictError(
    `${what} ${monthLabel(year, month)} is not possible — that payroll is already ${
      run.status === "LOCKED" ? "locked" : "approved"
    }, and the working days it was calculated from would no longer match the calendar.`,
  );
}
