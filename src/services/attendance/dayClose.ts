import type { EmploymentState } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { writeAnonymousAudit } from "@/lib/audit";
import { type DateOnly, compare, instantInZone, todayInZone } from "@/domain/date";
import { buildPeriodCalendar, type HolidayEntry } from "@/domain/calendar";
import {
  NO_CHECK_IN_REMARK,
  NO_CHECK_OUT_REMARK,
  closableDates,
  isDateClosed,
  isOnRoll,
  settleOpenRow,
} from "@/domain/attendance/dayClose";
import { type AttendanceStatus, mayMarkFromOwnDevice } from "@/domain/attendance/policy";
import { resolveWeeklyOff } from "@/services/org/weeklyOff";
import { type AttendanceRules, getAttendanceRulesForOrganization } from "@/services/policy";

/**
 * The close of the day.
 *
 * Runs once a night for every organisation (from `runMaintenanceJobs`), and
 * on demand from an operator script. For every date old enough that nobody
 * can mark it any more, it writes down the two things nobody wrote down
 * before:
 *
 *   - a person on the roll who never checked in on a working day is ABSENT,
 *     as a row of its own -- the grid showed a blank, the totals said "not
 *     marked", and payroll had been counting the same blank as absent all
 *     along, so the record now says what the payslip already did;
 *   - a person who checked in and never checked out is settled through the
 *     organisation's missing-checkout rule, the same rule a check-out that
 *     never came would have met. Until then the row says `CHECKED_IN`.
 *
 * No `ctx`: the caller is the scheduler, not a person. Every query is scoped
 * by organisation, the same shape as `seedYearlyHolidays`. Nothing here
 * touches an overridden row, a leave row, a rest day, or anybody else's
 * status: the only rows it writes are new ABSENT rows and `CHECKED_IN` rows
 * with no check-out, and both writes are conditional, so a second run -- or a
 * check-out and an override landing in the same minute -- is a no-op.
 *
 * Two kinds of blank are left blank on purpose and counted so the operator
 * can see them: a working day an APPROVED leave request covers with no row
 * of its own (payroll's leave net answers for it; an ABSENT row here would
 * have docked a day that was already deducted from the balance), and a
 * working day for somebody who could not have marked by any path -- no work
 * location where one is required, or self-marking off with no kiosk. The
 * second is the system's configuration, not the person's absence.
 *
 * Read-only organisations are closed too. The close records facts; the
 * writable check guards what *people* may change.
 */

export interface DayCloseOptions {
  now: Date;
  /** Close from this date rather than the default lookback (an operator back-fill). */
  from?: DateOnly;
  /** Widen the lookback with `from` for a back-fill; the nightly run keeps the default. */
  lookbackDays?: number;
  /** One organisation only (the operator script); every ACTIVE one otherwise. */
  organizationId?: string;
  /** Plan everything, write nothing, and return the plan. */
  dryRun?: boolean;
}

export interface PlannedChange {
  employeeCode: string;
  employeeName: string;
  date: DateOnly;
  change: "ABSENT" | `CHECKED_IN → ${AttendanceStatus}`;
}

/** A working day with no row that the close deliberately left blank. */
export interface SkippedDay {
  employeeCode: string;
  employeeName: string;
  date: DateOnly;
  reason: "ON_LEAVE" | "CANNOT_MARK";
}

export interface DayCloseOrgSummary {
  organizationId: string;
  slug: string;
  name: string;
  /** The dates whose window had closed by `now`, oldest first. */
  dates: DateOnly[];
  absentCreated: number;
  openDaysClosed: number;
  /** Working days with no row that an approved leave request covers. */
  leaveWithoutRow: number;
  /** Working days with no row for somebody who could not have marked. */
  unmarkable: number;
  planned: PlannedChange[];
  skipped: SkippedDay[];
}

export interface DayCloseSummary {
  organizations: number;
  absentCreated: number;
  openDaysClosed: number;
  leaveWithoutRow: number;
  unmarkable: number;
  perOrg: DayCloseOrgSummary[];
  durationMs: number;
}

/** Employment states that take somebody off the roster for a *new* absence. */
const OFF_ROLL_STATES: EmploymentState[] = ["RESIGNED", "TERMINATED", "INACTIVE"];
const CREATE_CHUNK = 500;

function dateKey(employeeId: string, date: DateOnly): string {
  return `${employeeId}:${date}`;
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/**
 * Whether no path could have recorded this person's attendance on this date.
 *
 * The same two doors `markAttendance` and `markAtKiosk` check, read together:
 * the fence refuses anybody with no work location once the organisation
 * requires one, and a person whose self-marking is off can only be marked
 * by a kiosk the organisation may not have. Writing ABSENT behind two closed
 * doors would dock somebody for a setting.
 */
function cannotMark(
  employee: { workLocationId: string | null; allowSelfMarking: boolean | null },
  rules: AttendanceRules,
): boolean {
  if (rules.requireWorkLocation && !employee.workLocationId) return true;
  return !mayMarkFromOwnDevice(rules, employee) && !rules.marking.kiosk;
}

export async function closeAttendanceDays(options: DayCloseOptions): Promise<DayCloseSummary> {
  const startedAt = Date.now();
  const organizations = await prisma.organization.findMany({
    where: {
      status: "ACTIVE",
      ...(options.organizationId ? { id: options.organizationId } : {}),
    },
    select: { id: true, slug: true, name: true, timezone: true },
    orderBy: { name: "asc" },
  });

  const perOrg: DayCloseOrgSummary[] = [];
  for (const organization of organizations) {
    perOrg.push(await closeOrganization(organization, options));
  }

  return {
    organizations: perOrg.length,
    absentCreated: perOrg.reduce((n, o) => n + o.absentCreated, 0),
    openDaysClosed: perOrg.reduce((n, o) => n + o.openDaysClosed, 0),
    leaveWithoutRow: perOrg.reduce((n, o) => n + o.leaveWithoutRow, 0),
    unmarkable: perOrg.reduce((n, o) => n + o.unmarkable, 0),
    perOrg,
    durationMs: Date.now() - startedAt,
  };
}

async function closeOrganization(
  organization: { id: string; slug: string; name: string; timezone: string },
  options: DayCloseOptions,
): Promise<DayCloseOrgSummary> {
  const { now } = options;
  const timeZone = organization.timezone;
  const today = todayInZone(timeZone, now);
  const summary: DayCloseOrgSummary = {
    organizationId: organization.id,
    slug: organization.slug,
    name: organization.name,
    dates: [],
    absentCreated: 0,
    openDaysClosed: 0,
    leaveWithoutRow: 0,
    unmarkable: 0,
    planned: [],
    skipped: [],
  };

  // Policies are versioned, so each date is judged by the rules in force on
  // it -- a shift moved from 09:00 to 10:00 on the 15th closes the 14th by the
  // old clock. True now that `loadPolicy` reads history rather than only the
  // head: with the `active` filter it used to carry, the 14th matched no
  // version at all and was closed by the shipped defaults.
  const rulesByDate = new Map<DateOnly, AttendanceRules>();
  const rulesFor = async (date: DateOnly): Promise<AttendanceRules> => {
    const cached = rulesByDate.get(date);
    if (cached) return cached;
    const rules = await getAttendanceRulesForOrganization(organization.id, date);
    rulesByDate.set(date, rules);
    return rules;
  };

  const candidates = closableDates({ today, from: options.from, lookbackDays: options.lookbackDays });
  const dates: DateOnly[] = [];
  for (const date of candidates) {
    if (isDateClosed(date, await rulesFor(date), timeZone, now)) dates.push(date);
  }
  summary.dates = dates;
  if (dates.length === 0) return summary;

  const first = dates[0] as DateOnly;
  const last = dates[dates.length - 1] as DateOnly;
  const range = {
    gte: new Date(`${first}T00:00:00.000Z`),
    lte: new Date(`${last}T00:00:00.000Z`),
  };

  // Everybody, whatever their state today. An open CHECKED_IN row belongs to
  // whoever was working that night, and a person who resigned on the 20th
  // still has the 18th to settle: with `active` and the state filter here,
  // those rows stayed CHECKED_IN for ever and payroll's final month settled
  // them by the default rule instead of the organisation's. The roster --
  // active, not exited, on the roll that date -- decides only who gets a
  // *new* ABSENT row.
  const employees = await prisma.employee.findMany({
    where: { organizationId: organization.id },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      active: true,
      employmentState: true,
      departmentId: true,
      joiningDate: true,
      exitDate: true,
      workLocationId: true,
      allowSelfMarking: true,
      weeklyOffConfig: true,
      weeklyOffPattern: { select: { config: true } },
      trainingPlans: { select: { startDate: true, endDate: true } },
    },
    orderBy: { employeeCode: "asc" },
  });

  const holidays: HolidayEntry[] = (
    await prisma.holiday.findMany({
      where: { organizationId: organization.id, date: range },
      select: {
        id: true,
        name: true,
        date: true,
        paid: true,
        optional: true,
        departmentIds: true,
        employeeIds: true,
        regions: true,
      },
    })
  ).map((h) => ({ ...h, date: toDateOnly(h.date) }));

  const rows = await prisma.attendanceDay.findMany({
    where: { organizationId: organization.id, date: range },
    select: {
      id: true,
      employeeId: true,
      date: true,
      status: true,
      firstCheckInAt: true,
      lastCheckOutAt: true,
      overriddenAt: true,
    },
  });
  const rowByKey = new Map(rows.map((r) => [dateKey(r.employeeId, toDateOnly(r.date)), r]));

  // Approved leave over the range, one query for the organisation, indexed by
  // employee. The same shape payroll's leave safety net reads
  // (`inputBuilder.ts`): a day it will count as leave must not be written
  // ABSENT here first.
  const leaveByEmployee = new Map<string, { from: DateOnly; to: DateOnly }[]>();
  for (const leave of await prisma.leaveRequest.findMany({
    where: {
      organizationId: organization.id,
      status: "APPROVED",
      startDate: { lte: range.lte },
      endDate: { gte: range.gte },
    },
    select: { employeeId: true, startDate: true, endDate: true },
  })) {
    const spans = leaveByEmployee.get(leave.employeeId) ?? [];
    spans.push({ from: toDateOnly(leave.startDate), to: toDateOnly(leave.endDate) });
    leaveByEmployee.set(leave.employeeId, spans);
  }
  const onApprovedLeave = (employeeId: string, date: DateOnly): boolean =>
    (leaveByEmployee.get(employeeId) ?? []).some(
      (span) => compare(date, span.from) >= 0 && compare(date, span.to) <= 0,
    );

  const absences: {
    organizationId: string;
    employeeId: string;
    date: Date;
    status: "ABSENT";
    systemStatus: "ABSENT";
    source: "SYSTEM";
    remarks: string;
  }[] = [];
  const settlements: { id: string; data: Record<string, unknown>; label: PlannedChange }[] = [];

  for (const employee of employees) {
    const weeklyOff = await resolveWeeklyOff(prisma, organization.id, employee);
    const calendar = buildPeriodCalendar(
      first,
      last,
      { employeeId: employee.id, departmentId: employee.departmentId, weeklyOff },
      holidays,
    );
    const kindByDate = new Map(calendar.days.map((d) => [d.date, d.kind]));
    const roll = {
      joiningDate: toDateOnly(employee.joiningDate),
      exitDate: employee.exitDate ? toDateOnly(employee.exitDate) : null,
    };
    const onRoster = employee.active && !OFF_ROLL_STATES.includes(employee.employmentState);
    const name = `${employee.firstName} ${employee.lastName ?? ""}`.trim();

    for (const date of dates) {
      const kind = kindByDate.get(date) ?? "WORKING";
      const row = rowByKey.get(dateKey(employee.id, date));

      if (!row) {
        // A new absence is written only for somebody on the roster that day.
        if (!onRoster || !isOnRoll(roll, date)) continue;
        // A rest day with no row stays blank, as payroll already reads it.
        if (kind !== "WORKING") continue;
        // Approved leave with no row of its own -- approved before the leave
        // module wrote attendance rows, or a row an administrator removed --
        // is leave, and payroll's safety net will say so. An ABSENT row here
        // would have been read first and docked a day already deducted from
        // the balance.
        if (onApprovedLeave(employee.id, date)) {
          summary.leaveWithoutRow++;
          summary.skipped.push({ employeeCode: employee.employeeCode, employeeName: name, date, reason: "ON_LEAVE" });
          continue;
        }
        if (cannotMark(employee, await rulesFor(date))) {
          summary.unmarkable++;
          summary.skipped.push({ employeeCode: employee.employeeCode, employeeName: name, date, reason: "CANNOT_MARK" });
          continue;
        }
        absences.push({
          organizationId: organization.id,
          employeeId: employee.id,
          date: new Date(`${date}T00:00:00.000Z`),
          status: "ABSENT",
          systemStatus: "ABSENT",
          source: "SYSTEM",
          remarks: NO_CHECK_IN_REMARK,
        });
        summary.planned.push({ employeeCode: employee.employeeCode, employeeName: name, date, change: "ABSENT" });
        continue;
      }

      if (row.status !== "CHECKED_IN" || !row.firstCheckInAt || row.lastCheckOutAt || row.overriddenAt) {
        continue;
      }
      const rules = await rulesFor(date);
      const checkInAt = row.firstCheckInAt;
      const training = employee.trainingPlans.some((p) => p.startDate <= checkInAt && p.endDate >= checkInAt);
      // On the shift day's minute axis. A night shift's check-in after
      // midnight sits on the previous date's row (`shiftDayFor`), so its
      // wall-clock minute is 1440 short: a 00:30 arrival on a 22:00 shift read
      // as minute 30 of the shift day, before the shift had started, and the
      // late minutes came out zero instead of 150.
      const local = instantInZone(checkInAt, timeZone);
      const checkInMinutes = compare(local.date, date) > 0 ? local.minutes + 1440 : local.minutes;
      const verdict = settleOpenRow({ dayKind: kind, checkInMinutes, training }, rules);
      settlements.push({
        id: row.id,
        data: {
          status: verdict.status,
          systemStatus: verdict.status,
          workedMinutes: verdict.workedMinutes,
          lateMinutes: verdict.lateMinutes,
          earlyLeaveMinutes: verdict.earlyLeaveMinutes,
          overtimeMinutes: verdict.overtimeMinutes,
          isExtraDay: verdict.isExtraDay,
          remarks: NO_CHECK_OUT_REMARK,
        },
        label: {
          employeeCode: employee.employeeCode,
          employeeName: name,
          date,
          change: `CHECKED_IN → ${verdict.status}`,
        },
      });
      summary.planned.push(settlements[settlements.length - 1]!.label);
    }
  }

  if (options.dryRun) {
    summary.absentCreated = absences.length;
    summary.openDaysClosed = settlements.length;
    return summary;
  }

  // `skipDuplicates` against the (employeeId, date) unique: a mark that landed
  // between the read above and this write keeps its row, and a second run of
  // the same night creates nothing.
  for (let i = 0; i < absences.length; i += CREATE_CHUNK) {
    const created = await prisma.attendanceDay.createMany({
      data: absences.slice(i, i + CREATE_CHUNK),
      skipDuplicates: true,
    });
    summary.absentCreated += created.count;
  }

  // Conditional on the row still being open and untouched: a check-out or an
  // administrator's override that landed since the read wins, and the close
  // says nothing.
  for (const settlement of settlements) {
    const updated = await prisma.attendanceDay.updateMany({
      where: { id: settlement.id, status: "CHECKED_IN", overriddenAt: null, lastCheckOutAt: null },
      data: settlement.data,
    });
    summary.openDaysClosed += updated.count;
  }

  // One line per organisation per night, and only when something was written:
  // a row saying "closed nothing" for every organisation every night is noise
  // in exactly the log somebody reads to find out what happened.
  if (summary.absentCreated > 0 || summary.openDaysClosed > 0) {
    await writeAnonymousAudit({
      organizationId: organization.id,
      action: "attendance.day_closed",
      entityType: "AttendanceDay",
      metadata: {
        from: first,
        to: last,
        absentCreated: summary.absentCreated,
        openDaysClosed: summary.openDaysClosed,
        leaveWithoutRow: summary.leaveWithoutRow,
        unmarkable: summary.unmarkable,
      },
    });
  }

  return summary;
}
