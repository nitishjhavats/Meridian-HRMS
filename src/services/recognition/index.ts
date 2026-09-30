import type {
  RecognitionDirection,
  RecognitionSource,
  RecognitionStatus,
  RecognitionUnit,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import {
  addDays,
  endOfMonth,
  monthLabel,
  startOfMonth,
  todayInZone,
  zonedTimeToInstant,
} from "@/domain/date";
import {
  MAX_PARAMETERS,
  type CohortMember,
  type ScoringParameter,
  type TieBreakReason,
  REQUIRED_WEIGHT_TOTAL,
  scoreCohort,
  totalWeight,
} from "@/domain/recognition/scoring";
import { SOURCE_UNIT, type RecognitionSourceKey } from "@/domain/recognition/units";
import { createAnnouncement } from "@/services/announcements";

/**
 * Employee of the Month.
 *
 * Three things keep this honest, and every function here exists to protect one
 * of them.
 *
 * **The ranking is arithmetic.** `@/domain/recognition/scoring` does the sums
 * with no database and no context, so it can be tested exhaustively and read by
 * anybody. This module's job is only to assemble the cohort and the figures.
 *
 * **Draft, then publish.** A cycle computes as often as you like and shows every
 * number; nothing is visible to the organisation until somebody publishes it.
 * A live leaderboard nobody agreed to is surveillance, and the manual figures
 * are not all in until the month is over.
 *
 * **The normalised figures are frozen at publish.** Recomputing them later would
 * give a different answer once somebody has joined, left or had a figure
 * corrected — so the published month keeps the arithmetic it was decided by,
 * and a dispute is about a stored number rather than a re-run.
 */

/**
 * How many places are published.
 *
 * The winner and two runners-up. Publishing a full ranking of everybody would
 * turn recognition into a league table of the whole company, which is the thing
 * the draft/publish split exists to prevent.
 */
const PUBLISHED_PLACES = 3;

/** Statuses that mean the person was at work that day. */
const PRESENT_ISH = ["FULL_DAY", "HALF_DAY", "EXTRA_DAY", "TRAINING_DAY", "ON_DUTY"] as const;

/**
 * Employment states that can win.
 *
 * Notice period is out, because an award announced to the company the week
 * somebody leaves helps nobody, and so are the three states that mean they have
 * already gone.
 */
const ELIGIBLE_STATES = ["TRAINING", "PROBATION", "REGULAR", "CONFIRMED"] as const;

/** A cooldown longer than this is indistinguishable from switching the scheme off. */
const MAX_COOLDOWN_MONTHS = 24;

/* ------------------------------------------------------------------ settings */

export interface RecognitionSettings {
  /**
   * Somebody who won within this many months is not eligible. 0 switches it off,
   * which is the default.
   *
   * It exists because the commonest failure of these schemes is the same person
   * winning until everybody else stops caring.
   */
  cooldownMonths: number;
}

const DEFAULT_SETTINGS: RecognitionSettings = { cooldownMonths: 0 };

/**
 * Read from the module's own config blob rather than a new table.
 *
 * There is exactly one number to keep, it belongs to the module, and
 * `OrgModuleSetting.config` is already where a module's own settings live.
 */
async function readSettings(organizationId: string): Promise<RecognitionSettings> {
  const row = await prisma.orgModuleSetting.findUnique({
    where: { organizationId_moduleKey: { organizationId, moduleKey: "recognition" } },
    select: { config: true },
  });

  const config = (row?.config ?? {}) as Partial<RecognitionSettings>;
  const cooldown = Number(config.cooldownMonths);

  return {
    cooldownMonths:
      Number.isInteger(cooldown) && cooldown >= 0 && cooldown <= MAX_COOLDOWN_MONTHS
        ? cooldown
        : DEFAULT_SETTINGS.cooldownMonths,
  };
}

/* --------------------------------------------------------------- parameters */

export interface ParameterView {
  id: string;
  name: string;
  unit: RecognitionUnit;
  direction: RecognitionDirection;
  weight: number;
  source: RecognitionSource;
  active: boolean;
  /** True once a published month has scored it, so deleting it would orphan history. */
  used: boolean;
}

export interface RecognitionSetup {
  parameters: ParameterView[];
  settings: RecognitionSettings;
  weightsTotal: number;
  weightsValid: boolean;
  maxParameters: number;
}

/**
 * What the month is decided on.
 *
 * Deliberately readable by everybody in the organisation with no permission
 * beyond the module being on: a scheme whose rules only the people who set them
 * can see is not a scheme anybody can trust.
 */
export async function getRecognitionSetup(ctx: AuthContext): Promise<RecognitionSetup> {
  requireOrg(ctx);
  requireModule(ctx, "recognition");

  const [rows, settings] = await Promise.all([
    prisma.recognitionParameter.findMany({
      where: { organizationId: ctx.organizationId! },
      orderBy: [{ active: "desc" }, { weight: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        unit: true,
        direction: true,
        weight: true,
        source: true,
        active: true,
        _count: { select: { scores: true } },
      },
    }),
    readSettings(ctx.organizationId!),
  ]);

  const parameters: ParameterView[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    unit: r.unit,
    direction: r.direction,
    weight: r.weight,
    source: r.source,
    active: r.active,
    used: r._count.scores > 0,
  }));

  const active = parameters.filter((p) => p.active);
  const weights = totalWeight(active.map(toScoringParameter));

  return {
    parameters,
    settings,
    weightsTotal: weights,
    weightsValid: weights === REQUIRED_WEIGHT_TOTAL,
    maxParameters: MAX_PARAMETERS,
  };
}

function toScoringParameter(p: {
  id: string;
  name: string;
  weight: number;
  direction: RecognitionDirection;
}): ScoringParameter {
  return { id: p.id, name: p.name, weight: p.weight, direction: p.direction };
}

export interface ParameterInput {
  /** Absent for a new one. */
  id?: string;
  name: string;
  unit: RecognitionUnit;
  direction: RecognitionDirection;
  weight: number;
  source: RecognitionSource;
  active?: boolean;
}

export interface SaveParametersInput {
  parameters: ParameterInput[];
  cooldownMonths?: number;
}

/**
 * Replaces the whole set in one go.
 *
 * Saving them together rather than one at a time is what makes "the weights must
 * total 100" enforceable: saved individually there is no moment at which the set
 * is required to add up, and the scheme spends most of its life invalid.
 *
 * Nothing is deleted here. A parameter left out of the payload is deactivated,
 * because a published month's scores still point at it.
 */
export async function saveParameters(
  ctx: AuthContext,
  input: SaveParametersInput,
): Promise<RecognitionSetup> {
  requireOrg(ctx);
  requireWrite(ctx, "recognition.manage", "recognition");

  const existing = await prisma.recognitionParameter.findMany({
    where: { organizationId: ctx.organizationId! },
    select: { id: true, name: true, unit: true, direction: true, weight: true, source: true, active: true },
  });
  const byId = new Map(existing.map((p) => [p.id, p]));
  const byName = new Map(existing.map((p) => [p.name.toLowerCase(), p]));

  // Every id in the payload must be one of this organisation's own. A row from
  // another tenant reads as missing, never as forbidden.
  for (const parameter of input.parameters) {
    if (parameter.id && !byId.has(parameter.id)) throw new NotFoundError("That parameter");
  }

  const cleaned = input.parameters.map((parameter) => {
    const name = parameter.name.trim();
    if (name.length < 2) throw new ValidationError("Give every parameter a name.");
    if (name.length > 60) throw new ValidationError(`"${name}" is too long for a parameter name.`);
    if (!Number.isInteger(parameter.weight) || parameter.weight < 0 || parameter.weight > 100) {
      throw new ValidationError(`The weight for ${name} must be a whole number between 0 and 100.`);
    }

    // A derived parameter's unit is decided by where the figure comes from —
    // days present are a count however the form was filled in.
    const forced = SOURCE_UNIT[parameter.source as RecognitionSourceKey];

    // Names are unique per organisation, so a row arriving without an id but
    // with the name of one that was switched off is the *same* parameter coming
    // back — not a new one that would collide on insert. Reusing it also keeps
    // whatever history it already has attached.
    const sameName = byName.get(name.toLowerCase());
    const id = parameter.id ?? sameName?.id;
    if (sameName && sameName.id !== id) {
      throw new ValidationError(`There is already a parameter called "${name}".`);
    }

    return {
      ...parameter,
      id,
      name,
      unit: (forced ?? parameter.unit) as RecognitionUnit,
      active: parameter.active ?? true,
    };
  });

  const active = cleaned.filter((p) => p.active);

  if (active.length > MAX_PARAMETERS) {
    throw new ValidationError(
      `Employee of the Month can be decided on at most ${MAX_PARAMETERS} things. Past that, nobody can be told why they did not win.`,
    );
  }

  const seen = new Set<string>();
  for (const parameter of cleaned) {
    const key = parameter.name.toLowerCase();
    if (seen.has(key)) throw new ValidationError(`There is more than one parameter called "${parameter.name}".`);
    seen.add(key);
  }

  // One source can only be counted once: two parameters both reading "days
  // present" would weight the same figure twice under two names.
  const sources = new Set<string>();
  for (const parameter of active) {
    if (parameter.source === "MANUAL") continue;
    if (sources.has(parameter.source)) {
      throw new ValidationError("Two parameters cannot be counted from the same source.");
    }
    sources.add(parameter.source);
  }

  const weights = totalWeight(active.map((p) => ({ ...p, id: p.id ?? p.name })));
  // Zero active parameters means the scheme is not set up yet, which is a fair
  // state to save from. Anything else has to add up.
  if (active.length > 0 && weights !== REQUIRED_WEIGHT_TOTAL) {
    throw new ValidationError(
      `The weights of the parameters in use must add up to ${REQUIRED_WEIGHT_TOTAL}. They currently add up to ${weights}.`,
    );
  }

  const cooldownMonths = input.cooldownMonths ?? (await readSettings(ctx.organizationId!)).cooldownMonths;
  if (!Number.isInteger(cooldownMonths) || cooldownMonths < 0 || cooldownMonths > MAX_COOLDOWN_MONTHS) {
    throw new ValidationError(`The cooldown must be between 0 and ${MAX_COOLDOWN_MONTHS} months.`);
  }

  const keptIds = new Set(cleaned.map((p) => p.id).filter((id): id is string => Boolean(id)));

  await prisma.$transaction(async (tx) => {
    for (const parameter of cleaned) {
      const data = {
        name: parameter.name,
        unit: parameter.unit,
        direction: parameter.direction,
        weight: parameter.weight,
        source: parameter.source,
        active: parameter.active,
      };

      if (parameter.id) {
        await tx.recognitionParameter.update({ where: { id: parameter.id }, data });
      } else {
        const created = await tx.recognitionParameter.create({
          data: { ...data, organizationId: ctx.organizationId! },
          select: { id: true },
        });
        // The row exists now, so the sweep below would read it as one that was
        // left out of the payload and switch it straight back off — every new
        // parameter saved, then silently deactivated, and a scheme set up from
        // scratch arriving at "no parameters are switched on yet".
        keptIds.add(created.id);
      }
    }

    // Removed from the screen, not from the database: a published month's
    // scores still point at it, and history that loses its column is history
    // nobody can check.
    await tx.recognitionParameter.updateMany({
      where: { organizationId: ctx.organizationId!, id: { notIn: [...keptIds] } },
      data: { active: false },
    });

    await tx.orgModuleSetting.upsert({
      where: {
        organizationId_moduleKey: { organizationId: ctx.organizationId!, moduleKey: "recognition" },
      },
      create: {
        organizationId: ctx.organizationId!,
        moduleKey: "recognition",
        // The module is already on — this row exists to hold its config, and
        // creating it must not read as switching anything on or off.
        enabled: true,
        config: { cooldownMonths },
        updatedById: ctx.userId,
      },
      update: { config: { cooldownMonths }, updatedById: ctx.userId },
    });
  });

  await writeAudit(ctx, {
    action: "recognition.parameters_updated",
    entityType: "RecognitionParameter",
    before: {
      parameters: existing.map((p) => ({ name: p.name, weight: p.weight, active: p.active })),
    },
    after: {
      parameters: cleaned.map((p) => ({
        name: p.name,
        weight: p.weight,
        active: p.active,
        source: p.source,
        direction: p.direction,
      })),
      cooldownMonths,
    },
  });

  return getRecognitionSetup(ctx);
}

/**
 * Removes a parameter outright, but only one no month has ever scored.
 *
 * Anything that has been published is deactivated instead. Deleting it would
 * cascade away the scores that explain a past result, and an award nobody can
 * check is worth less than no award.
 */
export async function deleteParameter(
  ctx: AuthContext,
  parameterId: string,
): Promise<{ deleted: boolean }> {
  requireOrg(ctx);
  requireWrite(ctx, "recognition.manage", "recognition");

  const parameter = await prisma.recognitionParameter.findFirst({
    where: { id: parameterId, organizationId: ctx.organizationId! },
    select: { id: true, name: true, weight: true, _count: { select: { scores: true } } },
  });
  if (!parameter) throw new NotFoundError("That parameter");

  const deleted = parameter._count.scores === 0;

  if (deleted) {
    await prisma.recognitionParameter.delete({ where: { id: parameter.id } });
  } else {
    await prisma.recognitionParameter.update({
      where: { id: parameter.id },
      data: { active: false, weight: 0 },
    });
  }

  await writeAudit(ctx, {
    action: "recognition.parameter_deleted",
    entityType: "RecognitionParameter",
    entityId: parameter.id,
    before: { name: parameter.name, weight: parameter.weight },
    metadata: { deleted, scoredMonths: parameter._count.scores },
  });

  return { deleted };
}

/* ------------------------------------------------------------------- period */

export interface Period {
  year: number;
  month: number;
  label: string;
}

function assertPeriod(year: number, month: number): Period {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ValidationError("That is not a month this can be run for.");
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValidationError("That is not a month this can be run for.");
  }
  return { year, month, label: monthLabel(year, month) };
}

function monthBounds(year: number, month: number): { first: Date; last: Date; firstDay: string; lastDay: string } {
  const firstDay = startOfMonth(year, month);
  const lastDay = endOfMonth(year, month);
  return {
    firstDay,
    lastDay,
    first: new Date(`${firstDay}T00:00:00.000Z`),
    last: new Date(`${lastDay}T00:00:00.000Z`),
  };
}

/** The month before the one in progress — the last one there is complete data for. */
export function defaultPeriod(ctx: AuthContext): Period {
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? assertPeriod(year - 1, 12) : assertPeriod(year, month - 1);
}

/* ------------------------------------------------------------------- cohort */

export type ExclusionReason =
  | "LEFT"
  | "ON_NOTICE"
  | "NOT_ACTIVE"
  | "JOINED_MID_MONTH"
  | "RECENT_WINNER";

export interface ExcludedEmployee {
  employeeId: string;
  name: string;
  employeeCode: string;
  reason: ExclusionReason;
  detail: string;
}

interface CohortEmployee {
  id: string;
  name: string;
  employeeCode: string;
  photoUrl: string | null;
  designation: string | null;
  department: string | null;
  joiningDate: string;
  userId: string | null;
}

/**
 * Who was in the running, and who was not and why.
 *
 * The exclusions are returned rather than filtered away silently: "why is Meera
 * not on this list" is the first question anybody asks, and an answer the
 * screen can give is worth more than one an administrator has to reconstruct.
 */
async function buildCohort(
  ctx: AuthContext,
  period: Period,
  settings: RecognitionSettings,
): Promise<{ eligible: CohortEmployee[]; excluded: ExcludedEmployee[] }> {
  const { first, last } = monthBounds(period.year, period.month);

  const employees = await prisma.employee.findMany({
    where: {
      organizationId: ctx.organizationId!,
      // Anybody whose employment overlapped the month at all. People who joined
      // afterwards or left long before are not "excluded", they are irrelevant.
      joiningDate: { lte: last },
      OR: [{ exitDate: null }, { exitDate: { gte: first } }],
    },
    orderBy: { employeeCode: "asc" },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      photoKey: true,
      facePhotoKey: true,
      joiningDate: true,
      exitDate: true,
      employmentState: true,
      active: true,
      userId: true,
      designation: { select: { title: true } },
      department: { select: { name: true } },
    },
  });

  const recentWinners = await winnersWithinCooldown(ctx, period, settings.cooldownMonths);

  const eligible: CohortEmployee[] = [];
  const excluded: ExcludedEmployee[] = [];

  for (const e of employees) {
    const name = [e.firstName, e.lastName].filter(Boolean).join(" ");
    const joiningDate = e.joiningDate.toISOString().slice(0, 10);
    const identity = { employeeId: e.id, name, employeeCode: e.employeeCode };

    if (e.exitDate && e.exitDate <= last) {
      excluded.push({ ...identity, reason: "LEFT", detail: "Left during or before the month." });
      continue;
    }
    if (e.employmentState === "NOTICE_PERIOD") {
      excluded.push({ ...identity, reason: "ON_NOTICE", detail: "On notice period." });
      continue;
    }
    if (!e.active || !(ELIGIBLE_STATES as readonly string[]).includes(e.employmentState)) {
      excluded.push({ ...identity, reason: "NOT_ACTIVE", detail: "Not an active employee." });
      continue;
    }
    // Employed for the whole month. Winning on three days of data is how these
    // schemes lose credibility — but somebody who started on the first was
    // there for every day of it, so the comparison is strictly after the first,
    // not on or after it.
    if (e.joiningDate > first) {
      excluded.push({
        ...identity,
        reason: "JOINED_MID_MONTH",
        detail: "Joined during the month, so there is not a full month to judge.",
      });
      continue;
    }
    const wonIn = recentWinners.get(e.id);
    if (wonIn) {
      excluded.push({
        ...identity,
        reason: "RECENT_WINNER",
        detail: `Won in ${wonIn}, inside the ${settings.cooldownMonths}-month cooldown.`,
      });
      continue;
    }

    eligible.push({
      id: e.id,
      name,
      employeeCode: e.employeeCode,
      photoUrl: e.photoKey
        ? `/api/files/${e.photoKey}`
        : e.facePhotoKey
          ? `/api/files/${e.facePhotoKey}`
          : null,
      designation: e.designation?.title ?? null,
      department: e.department?.name ?? null,
      joiningDate,
      userId: e.userId,
    });
  }

  return { eligible, excluded };
}

/** Employee id → the month they last won, for anybody inside the cooldown window. */
async function winnersWithinCooldown(
  ctx: AuthContext,
  period: Period,
  cooldownMonths: number,
): Promise<Map<string, string>> {
  const winners = new Map<string, string>();
  if (cooldownMonths <= 0) return winners;

  const awards = await prisma.recognitionAward.findMany({
    // Published months only, and first place only. An award row that belongs to
    // a cycle which is not published has not been announced to anybody, and
    // barring somebody from this month over a win nobody has ever seen is a
    // penalty that cannot be explained. This matches how the same rows are
    // counted everywhere else — `awardCountsByEmployee` and the history list.
    where: { organizationId: ctx.organizationId!, rank: 1, cycle: { status: "PUBLISHED" } },
    select: { employeeId: true, cycle: { select: { periodYear: true, periodMonth: true } } },
  });

  // Months are compared as a single running index so that December to January
  // is one month apart, not eleven.
  const index = period.year * 12 + (period.month - 1);

  for (const award of awards) {
    const won = award.cycle.periodYear * 12 + (award.cycle.periodMonth - 1);
    const gap = index - won;
    if (gap > 0 && gap <= cooldownMonths) {
      winners.set(award.employeeId, monthLabel(award.cycle.periodYear, award.cycle.periodMonth));
    }
  }

  return winners;
}

/* --------------------------------------------------------- derived measures */

interface DerivedFigures {
  /** parameterId → employeeId → figure, or null when there is nothing to score. */
  byParameter: Map<string, Map<string, number | null>>;
  /** Days present, needed for the attendance tie-break whether or not it is scored. */
  presentDays: Map<string, number>;
}

/**
 * Everything the app can count for itself.
 *
 * Read straight from the data the organisation already keeps, so these need no
 * monthly typing and cannot drift from what attendance and performance say.
 */
async function derivedFigures(
  ctx: AuthContext,
  period: Period,
  parameters: { id: string; source: RecognitionSource }[],
  employeeIds: string[],
): Promise<DerivedFigures> {
  const byParameter = new Map<string, Map<string, number | null>>();
  const presentDays = new Map<string, number>();
  if (employeeIds.length === 0) return { byParameter, presentDays };

  const { first, last, firstDay, lastDay } = monthBounds(period.year, period.month);
  const dayWhere = {
    organizationId: ctx.organizationId!,
    employeeId: { in: employeeIds },
    date: { gte: first, lte: last },
  };

  // Attendance days are calendar dates and compare exactly. A goal carries a
  // real timestamp, so the month has to be turned into instants in the
  // organisation's own zone — otherwise a goal achieved at 2am on the 1st in
  // Kolkata counts towards the previous month.
  const zone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const monthStartedAt = zonedTimeToInstant(firstDay, 0, zone);
  const monthEndedAt = zonedTimeToInstant(addDays(lastDay, 1), 0, zone);

  const wanted = new Set(parameters.map((p) => p.source));

  const [present, onTime, overtime, goals] = await Promise.all([
    // Always counted: the tie-break uses it even when nobody scores attendance.
    prisma.attendanceDay.groupBy({
      by: ["employeeId"],
      where: { ...dayWhere, status: { in: [...PRESENT_ISH] } },
      _count: { _all: true },
    }),
    wanted.has("PUNCTUALITY")
      ? prisma.attendanceDay.groupBy({
          by: ["employeeId"],
          where: { ...dayWhere, status: { in: [...PRESENT_ISH] }, lateMinutes: 0 },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    wanted.has("OVERTIME_HOURS")
      ? prisma.attendanceDay.groupBy({
          by: ["employeeId"],
          where: dayWhere,
          _sum: { overtimeMinutes: true },
        })
      : Promise.resolve([]),
    wanted.has("GOALS_COMPLETED")
      ? prisma.goal.groupBy({
          by: ["employeeId"],
          where: {
            organizationId: ctx.organizationId!,
            employeeId: { in: employeeIds },
            status: "ACHIEVED",
            // When it was marked achieved, not when it was due: a goal with no
            // due date would otherwise never count for anybody.
            updatedAt: { gte: monthStartedAt, lt: monthEndedAt },
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
  ]);

  for (const row of present) presentDays.set(row.employeeId, row._count._all);
  const onTimeDays = new Map(onTime.map((r) => [r.employeeId, r._count._all]));
  const overtimeMinutes = new Map(overtime.map((r) => [r.employeeId, r._sum.overtimeMinutes ?? 0]));
  const goalsAchieved = new Map(goals.map((r) => [r.employeeId, r._count._all]));

  for (const parameter of parameters) {
    if (parameter.source === "MANUAL") continue;
    const values = new Map<string, number | null>();

    for (const employeeId of employeeIds) {
      switch (parameter.source) {
        case "PRESENT_DAYS":
          values.set(employeeId, presentDays.get(employeeId) ?? 0);
          break;
        case "PUNCTUALITY": {
          const days = presentDays.get(employeeId) ?? 0;
          // Nobody present has no punctuality, and scoring that as 0% would
          // read as "always late". Left as nothing entered, which puts them on
          // the list of gaps to look at instead.
          values.set(employeeId, days === 0 ? null : ((onTimeDays.get(employeeId) ?? 0) / days) * 100);
          break;
        }
        case "OVERTIME_HOURS":
          values.set(employeeId, (overtimeMinutes.get(employeeId) ?? 0) / 60);
          break;
        case "GOALS_COMPLETED":
          values.set(employeeId, goalsAchieved.get(employeeId) ?? 0);
          break;
      }
    }

    byParameter.set(parameter.id, values);
  }

  return { byParameter, presentDays };
}

/* ------------------------------------------------------------ monthly entry */

export interface MonthlyEntryRow {
  employeeId: string;
  name: string;
  employeeCode: string;
  designation: string | null;
  /** parameterId → what has been entered so far. */
  values: Record<string, number | null>;
}

export interface MonthlyEntry {
  period: Period;
  status: RecognitionStatus | "NOT_STARTED";
  /** Published months are read-only: the arithmetic behind an announced result cannot move. */
  editable: boolean;
  parameters: ParameterView[];
  rows: MonthlyEntryRow[];
}

/** The grid for typing in the figures the app cannot count for itself. */
export async function getMonthlyEntry(
  ctx: AuthContext,
  year: number,
  month: number,
): Promise<MonthlyEntry> {
  requireOrg(ctx);
  requireModule(ctx, "recognition");
  // Read, not write: a lapsed subscription must still be able to look at the
  // draft and last month's figures, it just cannot publish anything.
  requirePermission(ctx, "recognition.manage");

  const period = assertPeriod(year, month);
  const [setup, cycle] = await Promise.all([
    getRecognitionSetup(ctx),
    prisma.recognitionCycle.findUnique({
      where: {
        organizationId_periodYear_periodMonth: {
          organizationId: ctx.organizationId!,
          periodYear: period.year,
          periodMonth: period.month,
        },
      },
      select: { id: true, status: true },
    }),
  ]);

  const manual = setup.parameters.filter((p) => p.active && p.source === "MANUAL");
  const { eligible } = await buildCohort(ctx, period, setup.settings);

  const scores = cycle
    ? await prisma.recognitionScore.findMany({
        where: { cycleId: cycle.id },
        select: { employeeId: true, parameterId: true, rawValue: true },
      })
    : [];

  const entered = new Map<string, number>();
  for (const score of scores) entered.set(`${score.employeeId}:${score.parameterId}`, Number(score.rawValue));

  return {
    period,
    status: cycle?.status ?? "NOT_STARTED",
    editable: cycle?.status !== "PUBLISHED",
    parameters: manual,
    rows: eligible.map((e) => ({
      employeeId: e.id,
      name: e.name,
      employeeCode: e.employeeCode,
      designation: e.designation,
      values: Object.fromEntries(
        manual.map((p) => [p.id, entered.get(`${e.id}:${p.id}`) ?? null]),
      ),
    })),
  };
}

export interface MonthlyValueInput {
  employeeId: string;
  parameterId: string;
  /** null clears the figure, which is not the same as typing a zero. */
  rawValue: number | null;
}

/**
 * Records the figures somebody types in.
 *
 * Only the raw value is stored. The normalised one is written at publish and
 * not before, because it depends on the whole cohort and would be wrong the
 * moment the next figure is entered.
 */
export async function saveMonthlyValues(
  ctx: AuthContext,
  input: { year: number; month: number; values: MonthlyValueInput[] },
): Promise<{ saved: number }> {
  requireOrg(ctx);
  requireWrite(ctx, "recognition.manage", "recognition");

  const period = assertPeriod(input.year, input.month);
  if (input.values.length === 0) return { saved: 0 };

  const employeeIds = [...new Set(input.values.map((v) => v.employeeId))];
  const parameterIds = [...new Set(input.values.map((v) => v.parameterId))];

  // Both foreign keys are checked against this tenant before anything is
  // written, so a hand-made request cannot attach a figure to somebody else's
  // employee or somebody else's parameter.
  const [employees, parameters] = await Promise.all([
    prisma.employee.findMany({
      where: { id: { in: employeeIds }, organizationId: ctx.organizationId! },
      select: { id: true },
    }),
    prisma.recognitionParameter.findMany({
      where: { id: { in: parameterIds }, organizationId: ctx.organizationId! },
      select: { id: true, name: true, source: true },
    }),
  ]);

  if (employees.length !== employeeIds.length) throw new NotFoundError("That employee");
  if (parameters.length !== parameterIds.length) throw new NotFoundError("That parameter");

  const derived = parameters.find((p) => p.source !== "MANUAL");
  if (derived) {
    throw new ValidationError(
      `${derived.name} is counted from your own data, so it cannot be typed in.`,
    );
  }

  for (const value of input.values) {
    if (value.rawValue !== null && !Number.isFinite(value.rawValue)) {
      throw new ValidationError("Every figure must be a number.");
    }
  }

  const cycle = await ensureCycle(ctx, period);
  if (cycle.status === "PUBLISHED") {
    throw new ConflictError(
      `${period.label} has already been published, so its figures can no longer be changed.`,
    );
  }

  await prisma.$transaction(async (tx) => {
    for (const value of input.values) {
      const where = {
        cycleId_employeeId_parameterId: {
          cycleId: cycle.id,
          employeeId: value.employeeId,
          parameterId: value.parameterId,
        },
      };

      if (value.rawValue === null) {
        await tx.recognitionScore.deleteMany({
          where: { cycleId: cycle.id, employeeId: value.employeeId, parameterId: value.parameterId },
        });
        continue;
      }

      await tx.recognitionScore.upsert({
        where,
        create: {
          cycleId: cycle.id,
          employeeId: value.employeeId,
          parameterId: value.parameterId,
          rawValue: value.rawValue,
          // A placeholder until publish freezes the real one. It is never read
          // for a draft cycle — the preview normalises in memory.
          normalised: 0,
        },
        update: { rawValue: value.rawValue },
      });
    }
  });

  await writeAudit(ctx, {
    action: "recognition.values_entered",
    entityType: "RecognitionCycle",
    entityId: cycle.id,
    after: {
      period: period.label,
      figures: input.values.length,
      employees: employeeIds.length,
      parameters: parameters.map((p) => p.name),
    },
  });

  return { saved: input.values.length };
}

async function ensureCycle(
  ctx: AuthContext,
  period: Period,
): Promise<{ id: string; status: RecognitionStatus }> {
  const existing = await prisma.recognitionCycle.findUnique({
    where: {
      organizationId_periodYear_periodMonth: {
        organizationId: ctx.organizationId!,
        periodYear: period.year,
        periodMonth: period.month,
      },
    },
    select: { id: true, status: true },
  });
  if (existing) return existing;

  return prisma.recognitionCycle.create({
    data: {
      organizationId: ctx.organizationId!,
      periodYear: period.year,
      periodMonth: period.month,
    },
    select: { id: true, status: true },
  });
}

/* ------------------------------------------------------------------ preview */

export interface WorkingRow {
  parameterId: string;
  parameterName: string;
  unit: RecognitionUnit;
  direction: RecognitionDirection;
  source: RecognitionSource;
  weight: number;
  raw: number | null;
  missing: boolean;
  normalised: number;
  contribution: number;
  /** Everybody scored the same on it, so it decided nothing. */
  uniform: boolean;
}

export interface RankedRow {
  rank: number;
  employeeId: string;
  name: string;
  employeeCode: string;
  photoUrl: string | null;
  designation: string | null;
  department: string | null;
  totalScore: number;
  presentDays: number;
  workings: WorkingRow[];
  tie: { tiedWith: string[]; reason: TieBreakReason | null; parameterName: string | null } | null;
  /** Times this person has won before. */
  awardsWon: number;
}

export interface CyclePreview {
  period: Period;
  status: RecognitionStatus | "NOT_STARTED";
  publishedAt: string | null;
  citation: string | null;
  parameters: (ParameterView & { min: number | null; max: number | null; entered: number; uniform: boolean })[];
  settings: RecognitionSettings;
  weightsTotal: number;
  weightsValid: boolean;
  ranked: RankedRow[];
  excluded: ExcludedEmployee[];
  /** Named so a gap gets filled, rather than silently costing somebody the month. */
  incomplete: { employeeId: string; name: string; parameters: string[] }[];
  canPublish: boolean;
  blockers: string[];
  override: { employeeId: string; name: string; reason: string } | null;
}

interface Assembled {
  period: Period;
  setup: RecognitionSetup;
  active: ParameterView[];
  eligible: CohortEmployee[];
  excluded: ExcludedEmployee[];
  cohort: CohortMember[];
  presentDays: Map<string, number>;
  awardCounts: Record<string, number>;
  cycle: {
    id: string;
    status: RecognitionStatus;
    publishedAt: Date | null;
    citation: string | null;
    awards: {
      employeeId: string;
      overrideReason: string | null;
      employee: { firstName: string; lastName: string | null };
    }[];
  } | null;
}

/**
 * Everything a month needs to be scored: the cohort, the parameters and the
 * figures, from wherever each of them comes.
 *
 * Split out because the same assembly answers two questions — "what does this
 * month look like" and "what would it look like under different weights" — and
 * the second has to run on exactly the same data as the first, or it proves
 * nothing.
 */
async function assemble(ctx: AuthContext, period: Period): Promise<Assembled> {
  const setup = await getRecognitionSetup(ctx);
  const active = setup.parameters.filter((p) => p.active);

  const [cycle, { eligible, excluded }] = await Promise.all([
    prisma.recognitionCycle.findUnique({
      where: {
        organizationId_periodYear_periodMonth: {
          organizationId: ctx.organizationId!,
          periodYear: period.year,
          periodMonth: period.month,
        },
      },
      select: {
        id: true,
        status: true,
        publishedAt: true,
        citation: true,
        awards: {
          where: { overriddenById: { not: null } },
          select: { employeeId: true, overrideReason: true, employee: { select: { firstName: true, lastName: true } } },
        },
      },
    }),
    buildCohort(ctx, period, setup.settings),
  ]);

  const employeeIds = eligible.map((e) => e.id);
  const [figures, manualScores, awardCounts] = await Promise.all([
    derivedFigures(ctx, period, active, employeeIds),
    cycle
      ? prisma.recognitionScore.findMany({
          where: { cycleId: cycle.id },
          select: { employeeId: true, parameterId: true, rawValue: true },
        })
      : Promise.resolve([]),
    awardCountsByEmployee(ctx, employeeIds),
  ]);

  const manual = new Map<string, number>();
  for (const score of manualScores) {
    manual.set(`${score.employeeId}:${score.parameterId}`, Number(score.rawValue));
  }

  const cohort: CohortMember[] = eligible.map((employee) => {
    const values: Record<string, number | null> = {};
    for (const parameter of active) {
      values[parameter.id] =
        parameter.source === "MANUAL"
          ? (manual.get(`${employee.id}:${parameter.id}`) ?? null)
          : (figures.byParameter.get(parameter.id)?.get(employee.id) ?? null);
    }
    return {
      employeeId: employee.id,
      values,
      attendanceDays: figures.presentDays.get(employee.id) ?? 0,
      joiningDate: employee.joiningDate,
    };
  });

  return {
    period,
    setup,
    active,
    eligible,
    excluded,
    cohort,
    presentDays: figures.presentDays,
    awardCounts,
    cycle,
  };
}

/**
 * The draft, with every figure visible.
 *
 * Computes but writes nothing, so it can be reloaded as often as anybody likes
 * while the month's figures are still being typed in.
 */
export async function previewCycle(
  ctx: AuthContext,
  year: number,
  month: number,
): Promise<CyclePreview> {
  requireOrg(ctx);
  requireModule(ctx, "recognition");
  // Read, not write: a lapsed subscription must still be able to look at the
  // draft and last month's figures, it just cannot publish anything.
  requirePermission(ctx, "recognition.manage");

  const period = assertPeriod(year, month);
  const { setup, active, eligible, excluded, cohort, presentDays, awardCounts, cycle } =
    await assemble(ctx, period);

  const result = scoreCohort(active.map(toScoringParameter), cohort);
  const byId = new Map(eligible.map((e) => [e.id, e]));
  const parameterById = new Map(active.map((p) => [p.id, p]));

  const ranked: RankedRow[] = result.ranked.map((row) => {
    const employee = byId.get(row.employeeId)!;
    return {
      rank: row.rank,
      employeeId: row.employeeId,
      name: employee.name,
      employeeCode: employee.employeeCode,
      photoUrl: employee.photoUrl,
      designation: employee.designation,
      department: employee.department,
      totalScore: row.totalScore,
      presentDays: presentDays.get(row.employeeId) ?? 0,
      workings: row.breakdown.map((b) => {
        const parameter = parameterById.get(b.parameterId)!;
        return {
          parameterId: b.parameterId,
          parameterName: parameter.name,
          unit: parameter.unit,
          direction: parameter.direction,
          source: parameter.source,
          weight: b.weight,
          raw: b.raw,
          missing: b.missing,
          normalised: b.normalised,
          contribution: b.contribution,
          uniform: b.uniform,
        };
      }),
      tie: row.tie
        ? {
            tiedWith: row.tie.tiedWith,
            reason: row.tie.reason,
            parameterName: row.tie.parameterId
              ? (parameterById.get(row.tie.parameterId)?.name ?? null)
              : null,
          }
        : null,
      awardsWon: awardCounts[row.employeeId] ?? 0,
    };
  });

  const blockers: string[] = [];
  if (active.length === 0) blockers.push("No parameters are switched on yet.");
  if (active.length > 0 && !result.weightsValid) {
    blockers.push(`The weights add up to ${result.weightsTotal}, not ${REQUIRED_WEIGHT_TOTAL}.`);
  }
  if (eligible.length === 0) blockers.push("Nobody was eligible for this month.");
  if (cycle?.status === "PUBLISHED") blockers.push(`${period.label} has already been published.`);

  // Publishing a month that has not finished announces a result the last week
  // of figures could still overturn.
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  if (today <= monthBounds(period.year, period.month).lastDay) {
    blockers.push(`${period.label} is not over yet. The figures are not all in.`);
  }

  const overridden = cycle?.awards[0];

  return {
    period,
    status: cycle?.status ?? "NOT_STARTED",
    publishedAt: cycle?.publishedAt?.toISOString() ?? null,
    citation: cycle?.citation ?? null,
    // In the engine's own order — heaviest first — and not the order they came
    // back from the database. Each ranked row's workings are in that order too,
    // so a table can put a column header against a cell and be sure of it.
    parameters: result.parameters.map((scored) => ({
      ...parameterById.get(scored.id)!,
      min: scored.min,
      max: scored.max,
      entered: scored.entered,
      uniform: scored.uniform,
    })),
    settings: setup.settings,
    weightsTotal: result.weightsTotal,
    weightsValid: result.weightsValid,
    ranked,
    excluded,
    incomplete: result.incomplete.map((row) => ({
      employeeId: row.employeeId,
      name: byId.get(row.employeeId)?.name ?? row.employeeId,
      parameters: row.parameterIds.map((id) => parameterById.get(id)?.name ?? id),
    })),
    canPublish: blockers.length === 0,
    blockers,
    override: overridden
      ? {
          employeeId: overridden.employeeId,
          name: [overridden.employee.firstName, overridden.employee.lastName].filter(Boolean).join(" "),
          reason: overridden.overrideReason ?? "",
        }
      : null,
  };
}

export interface WeightedPlace {
  rank: number;
  employeeId: string;
  name: string;
  totalScore: number;
}

/**
 * One month, scored twice on two sets of weights.
 *
 * This is what turns "80% on sales rewards the closer, not the person who
 * covered three shifts nobody wanted" from a claim into a demonstration: the
 * real engine, the real month, and the name of whoever would actually win.
 *
 * Both rankings come from a single assembly of the cohort and the figures, so
 * the only thing that differs between them is the weights — which is the whole
 * point of showing them side by side. Nothing is written and no weight is
 * saved; applying them stays a separate, deliberate act.
 */
export async function compareWeightings(
  ctx: AuthContext,
  year: number,
  month: number,
  before: Record<string, number>,
  after: Record<string, number>,
): Promise<{ current: WeightedPlace[]; proposed: WeightedPlace[] }> {
  requireOrg(ctx);
  requireModule(ctx, "recognition");
  // Read, not write: a lapsed subscription must still be able to look at the
  // draft and last month's figures, it just cannot publish anything.
  requirePermission(ctx, "recognition.manage");

  const period = assertPeriod(year, month);
  const { active, eligible, cohort } = await assemble(ctx, period);
  const byId = new Map(eligible.map((e) => [e.id, e]));

  const rank = (weights: Record<string, number>): WeightedPlace[] =>
    scoreCohort(
      active.map((p) => ({
        ...toScoringParameter(p),
        // An unrecognised or non-integer weight falls back to the saved one
        // rather than to zero, so a partial suggestion cannot silently delete a
        // parameter from the comparison.
        weight: Number.isInteger(weights[p.id]) ? (weights[p.id] as number) : p.weight,
      })),
      cohort,
      { topN: 5 },
    ).ranked.map((row) => ({
      rank: row.rank,
      employeeId: row.employeeId,
      name: byId.get(row.employeeId)?.name ?? row.employeeId,
      totalScore: row.totalScore,
    }));

  return { current: rank(before), proposed: rank(after) };
}

/* ------------------------------------------------------------------ publish */

export interface PublishInput {
  year: number;
  month: number;
  /** Somebody other than the top score. Requires a reason, which is shown on the award. */
  winnerEmployeeId?: string;
  overrideReason?: string;
  citation?: string;
}

/**
 * Freezes the month and tells the organisation.
 *
 * Everything is recomputed here rather than trusted from the browser: the
 * screen holds a copy of the draft, and a copy is not evidence. The normalised
 * figures are written alongside the raw ones so the published result keeps the
 * arithmetic it was decided by.
 */
export async function publishCycle(
  ctx: AuthContext,
  input: PublishInput,
): Promise<{ cycleId: string; winnerEmployeeId: string }> {
  requireOrg(ctx);
  requireWrite(ctx, "recognition.manage", "recognition");

  const period = assertPeriod(input.year, input.month);
  const preview = await previewCycle(ctx, period.year, period.month);

  if (!preview.canPublish) {
    throw new ValidationError("This month cannot be published yet.", { issues: preview.blockers });
  }

  const computedWinner = preview.ranked[0];
  if (!computedWinner) throw new ValidationError("There is nobody to give the award to.");

  const overriding = Boolean(input.winnerEmployeeId) && input.winnerEmployeeId !== computedWinner.employeeId;
  const reason = input.overrideReason?.trim() ?? "";

  if (overriding && reason.length < 10) {
    throw new ValidationError(
      "Choosing somebody other than the top score needs a reason, and it is shown on the award.",
    );
  }

  const chosen = input.winnerEmployeeId
    ? preview.ranked.find((r) => r.employeeId === input.winnerEmployeeId)
    : computedWinner;
  if (!chosen) {
    throw new ValidationError("That person was not eligible for this month, so they cannot win it.");
  }

  // The winner first, then the computed order for the remaining places.
  const places = [chosen, ...preview.ranked.filter((r) => r.employeeId !== chosen.employeeId)].slice(
    0,
    PUBLISHED_PLACES,
  );

  const cycle = await ensureCycle(ctx, period);
  if (cycle.status === "PUBLISHED") {
    throw new ConflictError(`${period.label} has already been published.`);
  }

  const citation = input.citation?.trim() || null;

  await prisma.$transaction(async (tx) => {
    // Rewritten wholesale rather than patched: the draft holds only the manual
    // figures, and what has to survive is the complete set with the normalised
    // values this ranking came from.
    await tx.recognitionScore.deleteMany({ where: { cycleId: cycle.id } });
    await tx.recognitionScore.createMany({
      // A missing figure gets no row at all rather than a row saying zero. The
      // column cannot be null, so the absence of the row *is* how "nothing was
      // entered" is recorded — and a stored zero would later be indistinguishable
      // from a zero somebody actually typed.
      data: preview.ranked.flatMap((row) =>
        row.workings
          .filter((w) => !w.missing)
          .map((w) => ({
            cycleId: cycle.id,
            employeeId: row.employeeId,
            parameterId: w.parameterId,
            rawValue: w.raw ?? 0,
            normalised: w.normalised,
          })),
      ),
    });

    await tx.recognitionAward.deleteMany({ where: { cycleId: cycle.id } });
    await tx.recognitionAward.createMany({
      data: places.map((row, index) => ({
        organizationId: ctx.organizationId!,
        cycleId: cycle.id,
        employeeId: row.employeeId,
        rank: index + 1,
        totalScore: row.totalScore,
        overriddenById: index === 0 && overriding ? ctx.userId : null,
        overrideReason: index === 0 && overriding ? reason : null,
      })),
    });

    await tx.recognitionCycle.update({
      where: { id: cycle.id },
      data: {
        status: "PUBLISHED",
        publishedAt: new Date(),
        publishedById: ctx.userId,
        citation,
      },
    });
  });

  await writeAudit(ctx, {
    action: "recognition.published",
    entityType: "RecognitionCycle",
    entityId: cycle.id,
    after: {
      period: period.label,
      winner: chosen.name,
      winnerEmployeeId: chosen.employeeId,
      totalScore: chosen.totalScore,
      overridden: overriding,
      overrideReason: overriding ? reason : null,
      topScore: computedWinner.name,
      places: places.map((p) => ({ name: p.name, score: p.totalScore })),
    },
  });

  await announce(ctx, period, chosen, citation);

  return { cycleId: cycle.id, winnerEmployeeId: chosen.employeeId };
}

/**
 * Tells everybody, and tells the winner.
 *
 * Neither is allowed to fail the publish. The award is already written and
 * announcing it again is one click; losing the award because the announcements
 * module refused a post would be far worse — and the person publishing may
 * legitimately not have the permission to post at all.
 */
async function announce(
  ctx: AuthContext,
  period: Period,
  winner: RankedRow,
  citation: string | null,
): Promise<void> {
  if (ctx.modules.has("announcements") && ctx.permissions.has("announcement.create")) {
    try {
      await createAnnouncement(ctx, {
        title: `Employee of the Month — ${period.label}`,
        body:
          citation ??
          `${winner.name} is our Employee of the Month for ${period.label}, with a score of ${winner.totalScore} out of 100. The parameters and the figures behind it are on the Employee of the Month page.`,
        pinned: true,
      });
    } catch (error) {
      console.error("[recognition] could not post the announcement", { period: period.label, error });
    }
  }

  const employee = await prisma.employee.findFirst({
    where: { id: winner.employeeId, organizationId: ctx.organizationId! },
    select: { userId: true },
  });

  if (employee?.userId) {
    await notify.toUser(employee.userId, {
      type: "recognition.published",
      title: `You are Employee of the Month for ${period.label}`,
      body: citation ?? `Your score was ${winner.totalScore} out of 100.`,
      link: "/recognition",
    });
  }
}

/* ------------------------------------------------------------------- awards */

export interface AwardPlace {
  rank: number;
  employeeId: string;
  name: string;
  employeeCode: string;
  photoUrl: string | null;
  designation: string | null;
  department: string | null;
  totalScore: number;
  /** Set when an administrator chose this person over the top score. */
  overrideReason: string | null;
  awardsWon: number;
}

export interface PublishedAward {
  cycleId: string;
  period: Period;
  publishedAt: string;
  citation: string | null;
  places: AwardPlace[];
  /** The winner's figures as they stood, so the result stays checkable. */
  workings: {
    parameterId: string;
    parameterName: string;
    unit: RecognitionUnit;
    direction: RecognitionDirection;
    weight: number;
    raw: number | null;
    /** No figure was entered, so it scored zero. Shown, not hidden. */
    missing: boolean;
    normalised: number;
    contribution: number;
  }[];
  /**
   * The weights have been edited since this month was published, so the
   * contributions above no longer add up to the score beside them.
   *
   * The normalised figures are frozen per cycle but the weights are not — there
   * is nowhere in the schema to freeze them. Rather than quietly showing a table
   * that does not add up, the discrepancy is detected and said out loud.
   */
  weightsChangedSince: boolean;
}

/**
 * The most recently published month.
 *
 * Not "this calendar month": a month is published once it is over, so for the
 * first week of May the thing everybody wants to see is April.
 */
export async function getCurrentAward(ctx: AuthContext): Promise<PublishedAward | null> {
  requireOrg(ctx);
  requireModule(ctx, "recognition");

  const cycle = await prisma.recognitionCycle.findFirst({
    where: { organizationId: ctx.organizationId!, status: "PUBLISHED" },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    select: {
      id: true,
      periodYear: true,
      periodMonth: true,
      publishedAt: true,
      citation: true,
      awards: {
        orderBy: { rank: "asc" },
        select: {
          rank: true,
          employeeId: true,
          totalScore: true,
          overrideReason: true,
          employee: {
            select: {
              firstName: true,
              lastName: true,
              employeeCode: true,
              photoKey: true,
              facePhotoKey: true,
              designation: { select: { title: true } },
              department: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  if (!cycle || cycle.awards.length === 0) return null;

  const winner = cycle.awards[0]!;
  const [scored, scores, counts] = await Promise.all([
    // The parameters this month was decided on, taken from the month itself
    // rather than from the current settings — the settings may have changed
    // since, and the published arithmetic must not change with them.
    prisma.recognitionScore.findMany({
      where: { cycleId: cycle.id },
      distinct: ["parameterId"],
      select: {
        parameter: { select: { id: true, name: true, unit: true, direction: true, weight: true } },
      },
    }),
    prisma.recognitionScore.findMany({
      where: { cycleId: cycle.id, employeeId: winner.employeeId },
      select: { parameterId: true, rawValue: true, normalised: true },
    }),
    awardCountsByEmployee(
      ctx,
      cycle.awards.map((a) => a.employeeId),
    ),
  ]);

  const winnerScores = new Map(scores.map((s) => [s.parameterId, s]));

  const workings = scored
    .map(({ parameter }) => {
      // No row means no figure was entered, which scored zero. Kept in the
      // table so the contributions still add up to the score beside them.
      const score = winnerScores.get(parameter.id);
      const normalised = score ? Number(score.normalised) : 0;
      return {
        parameterId: parameter.id,
        parameterName: parameter.name,
        unit: parameter.unit,
        direction: parameter.direction,
        weight: parameter.weight,
        raw: score ? Number(score.rawValue) : null,
        missing: !score,
        normalised,
        contribution: Math.round(normalised * parameter.weight * 100) / 100,
      };
    })
    .sort((a, b) => b.weight - a.weight || a.parameterName.localeCompare(b.parameterName));

  // Half a mark of slack for the rounding; anything wider than that is a weight
  // that has moved since, not arithmetic drift.
  const recomputed = workings.reduce((sum, w) => sum + w.contribution, 0);

  return {
    cycleId: cycle.id,
    period: { year: cycle.periodYear, month: cycle.periodMonth, label: monthLabel(cycle.periodYear, cycle.periodMonth) },
    publishedAt: (cycle.publishedAt ?? new Date()).toISOString(),
    citation: cycle.citation,
    places: cycle.awards.map((award) => ({
      rank: award.rank,
      employeeId: award.employeeId,
      name: [award.employee.firstName, award.employee.lastName].filter(Boolean).join(" "),
      employeeCode: award.employee.employeeCode,
      photoUrl: award.employee.photoKey
        ? `/api/files/${award.employee.photoKey}`
        : award.employee.facePhotoKey
          ? `/api/files/${award.employee.facePhotoKey}`
          : null,
      designation: award.employee.designation?.title ?? null,
      department: award.employee.department?.name ?? null,
      totalScore: Number(award.totalScore),
      overrideReason: award.overrideReason,
      awardsWon: counts[award.employeeId] ?? 0,
    })),
    workings,
    weightsChangedSince: Math.abs(recomputed - Number(winner.totalScore)) > 0.5,
  };
}

export interface AwardHistoryRow {
  cycleId: string;
  period: Period;
  citation: string | null;
  winner: {
    employeeId: string;
    name: string;
    employeeCode: string;
    photoUrl: string | null;
    designation: string | null;
    totalScore: number;
    overrideReason: string | null;
  };
}

/** Every month that has been published, newest first. */
export async function listAwardHistory(
  ctx: AuthContext,
  options: { limit?: number } = {},
): Promise<AwardHistoryRow[]> {
  requireOrg(ctx);
  requireModule(ctx, "recognition");

  const awards = await prisma.recognitionAward.findMany({
    where: { organizationId: ctx.organizationId!, rank: 1, cycle: { status: "PUBLISHED" } },
    orderBy: [{ cycle: { periodYear: "desc" } }, { cycle: { periodMonth: "desc" } }],
    take: Math.min(options.limit ?? 36, 120),
    select: {
      employeeId: true,
      totalScore: true,
      overrideReason: true,
      cycle: { select: { id: true, periodYear: true, periodMonth: true, citation: true } },
      employee: {
        select: {
          firstName: true,
          lastName: true,
          employeeCode: true,
          photoKey: true,
          facePhotoKey: true,
          designation: { select: { title: true } },
        },
      },
    },
  });

  return awards.map((award) => ({
    cycleId: award.cycle.id,
    period: {
      year: award.cycle.periodYear,
      month: award.cycle.periodMonth,
      label: monthLabel(award.cycle.periodYear, award.cycle.periodMonth),
    },
    citation: award.cycle.citation,
    winner: {
      employeeId: award.employeeId,
      name: [award.employee.firstName, award.employee.lastName].filter(Boolean).join(" "),
      employeeCode: award.employee.employeeCode,
      photoUrl: award.employee.photoKey
        ? `/api/files/${award.employee.photoKey}`
        : award.employee.facePhotoKey
          ? `/api/files/${award.employee.facePhotoKey}`
          : null,
      designation: award.employee.designation?.title ?? null,
      totalScore: Number(award.totalScore),
      overrideReason: award.overrideReason,
    },
  }));
}

/**
 * How many times each of these people has won.
 *
 * Returns an empty map rather than throwing when the module is off: this
 * decorates the employee directory and a profile, and a switched-off module
 * should make a badge disappear, not take the page with it.
 */
export async function awardCountsByEmployee(
  ctx: AuthContext,
  employeeIds: string[],
): Promise<Record<string, number>> {
  if (!ctx.organizationId || !ctx.modules.has("recognition") || employeeIds.length === 0) return {};

  const counts = await prisma.recognitionAward.groupBy({
    by: ["employeeId"],
    where: {
      organizationId: ctx.organizationId,
      employeeId: { in: employeeIds },
      // First place only. "Won three times" has to mean won, not placed.
      rank: 1,
      cycle: { status: "PUBLISHED" },
    },
    _count: { _all: true },
  });

  return Object.fromEntries(counts.map((c) => [c.employeeId, c._count._all]));
}
