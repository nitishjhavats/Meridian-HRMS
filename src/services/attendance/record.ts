import type { AttendanceSource, KioskBypass, Prisma } from "@prisma/client";
import { FALLBACK_TIME_ZONE, isValidTimeZone } from "@/domain/date";
import type { AuthContext } from "@/lib/auth/context";
import { ConflictError } from "@/lib/errors";
import { instantInZone, type DateOnly } from "@/domain/date";
import { buildPeriodCalendar } from "@/domain/calendar";
import { resolveWeeklyOff } from "@/services/org/weeklyOff";
import { checkoutTooSoon, evaluateDay, type AttendanceStatus } from "@/domain/attendance/policy";
import type { FaceCandidate } from "@/domain/attendance/faceMatch";
import type { AttendanceRules } from "@/services/policy";

/**
 * Writing a day, whoever asked for it.
 *
 * Two paths reach this: somebody marking their own attendance on their phone,
 * and a shared office device marking it for whoever is standing at the screen.
 * They differ in how identity is established and in nothing else, so everything
 * after that decision lives here — because the parts that must not diverge are
 * exactly the parts nobody would notice diverging:
 *
 *   - the `@@unique([employeeId, date])` key, built at UTC midnight from the
 *     organisation's local date, which every report and the payroll input
 *     builder join on;
 *   - `systemStatus` always carrying the rules' verdict while `status` is left
 *     alone once an admin has overridden it;
 *   - the opening `firstCheckInAt` and the closing `lastCheckOutAt`, which are
 *     what a month's worked minutes are summed from.
 *
 * The read of today's row happens **inside** the transaction. It used to sit
 * outside, which was survivable when the only caller was one person on one
 * phone and is not once a kiosk can have two people tapping at once.
 */

export interface RecordableEmployee {
  id: string;
  firstName: string;
  departmentId: string | null;
  /**
   * Their own rest days, consulted before the pattern.
   *
   * Optional, because the two callers select the row themselves and this was
   * added after them. A caller that leaves the column out does not get to
   * ignore it: the day is read here, inside the transaction, so a person off
   * on Tuesday is a rest day on Tuesday whichever screen marked them.
   */
  weeklyOffConfig?: unknown;
  weeklyOffPattern: { config: unknown } | null;
  trainingPlans: { startDate: Date; endDate: Date }[];
}

/** Everything about *this* mark that the day evaluation does not decide. */
export interface EventFacts {
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  distanceMeters: number | null;
  withinGeofence: boolean;
  workLocationId: string | null;
  selfieKey: string | null;
  faceMatchScore: number | null;
  faceMatchPassed: boolean | null;
  faceMatchReason: string | null;
  flaggedForReview: boolean;
  deviceInfo?: Record<string, unknown> | null;
  ipAddress?: string | null;
  source: AttendanceSource;
  note?: string | null;
  kioskBypass?: KioskBypass | null;
  bypassById?: string | null;
}

export interface RecordAttendanceInput {
  employee: RecordableEmployee;
  type: "CHECK_IN" | "CHECK_OUT";
  now: Date;
  timezone: string;
  local: { date: DateOnly; minutes: number };
  rules: AttendanceRules;
  facts: EventFacts;
  /**
   * How the duplicate-punch refusal is worded. Self-service says "you"; a kiosk
   * has to name the person, because the screen is showing somebody else's card.
   */
  subject: "self" | "other";
}

export interface RecordAttendanceResult {
  eventId: string;
  dayId: string;
  status: AttendanceStatus;
  workedMinutes: number;
  lateMinutes: number;
}

/**
 * Refuses a check-out that follows the check-in too closely to be a departure.
 *
 * Three of them on one live organisation in four days, 9 to 60 seconds after
 * the check-in, each scoring the day ABSENT with nothing worked: the button
 * had turned into "Check out" and was pressed again. Under
 * `MIN_MINUTES_BEFORE_CHECKOUT` it is a mistake, and the honest answer is to
 * say so rather than record it.
 *
 * Exported so the two mark paths can ask *before* they store a selfie or run
 * the face engine -- a refusal that has already uploaded a photo and spent a
 * PIN is a refusal that cost something. `recordAttendance` asks again inside
 * the transaction, which is the answer that counts.
 */
export function assertCheckoutNotTooSoon(
  existing: { firstCheckInAt: Date | null } | null,
  now: Date,
  subject: "self" | "other",
  firstName: string,
): void {
  if (!existing?.firstCheckInAt) return;
  const { tooSoon, minutesSince } = checkoutTooSoon(existing.firstCheckInAt, now);
  if (!tooSoon) return;
  const ago =
    minutesSince === 0 ? "less than a minute ago" : `${minutesSince} ${minutesSince === 1 ? "minute" : "minutes"} ago`;
  throw new ConflictError(
    subject === "self"
      ? `You checked in ${ago}. Check out when you leave.`
      : `${firstName} checked in ${ago}. Check out when they leave.`,
  );
}

export async function recordAttendance(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  input: RecordAttendanceInput,
): Promise<RecordAttendanceResult> {
  const { employee, type, now, timezone, local, rules, facts } = input;
  const organizationId = ctx.organizationId!;
  const dayStart = new Date(`${local.date}T00:00:00.000Z`);

  const existingDay = await tx.attendanceDay.findUnique({
    where: { employeeId_date: { employeeId: employee.id, date: dayStart } },
    select: { firstCheckInAt: true, lastCheckOutAt: true, overriddenAt: true },
  });

  const who = input.subject === "self" ? "You" : employee.firstName;
  if (type === "CHECK_IN" && existingDay?.firstCheckInAt) {
    const at = formatLocal(existingDay.firstCheckInAt, timezone);
    throw new ConflictError(
      input.subject === "self"
        ? `You already checked in at ${at}. Check out instead, or ask your manager to correct the record.`
        : `${who} already checked in at ${at}. Check out instead.`,
    );
  }
  if (type === "CHECK_OUT" && !existingDay?.firstCheckInAt) {
    throw new ConflictError(
      input.subject === "self"
        ? "You have not checked in today, so there is nothing to check out from."
        : `${who} has not checked in today, so there is nothing to check out from.`,
    );
  }
  if (type === "CHECK_OUT") {
    assertCheckoutNotTooSoon(existingDay, now, input.subject, employee.firstName);
  }

  /**
   * A later check-out replaces the earlier one. Kept on purpose: an early
   * check-out that slipped past the guard above -- pressed at five minutes and
   * one second, or recorded before the guard existed -- is repaired by the real
   * one in the evening, and `lastCheckOutAt` is the column a month's worked
   * minutes are summed from. The event note says which time it replaced, so
   * the repair reads as one afterwards.
   */
  const replacedCheckOut =
    type === "CHECK_OUT" && existingDay?.lastCheckOutAt
      ? `Replaces the check-out at ${formatLocal(existingDay.lastCheckOutAt, timezone)}`
      : null;

  const weeklyOffConfig =
    employee.weeklyOffConfig !== undefined
      ? employee.weeklyOffConfig
      : ((
          await tx.employee.findUnique({
            where: { id: employee.id },
            select: { weeklyOffConfig: true },
          })
        )?.weeklyOffConfig ?? null);
  const weeklyOff = await resolveWeeklyOff(tx, organizationId, {
    weeklyOffConfig,
    weeklyOffPattern: employee.weeklyOffPattern,
  });

  const holidays = await tx.holiday.findMany({
    where: { organizationId, date: dayStart },
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
  });

  const calendar = buildPeriodCalendar(
    local.date,
    local.date,
    { employeeId: employee.id, departmentId: employee.departmentId, weeklyOff },
    holidays.map((h) => ({
      id: h.id,
      name: h.name,
      date: local.date,
      paid: h.paid,
      optional: h.optional,
      departmentIds: h.departmentIds,
      employeeIds: h.employeeIds,
      regions: h.regions,
    })),
  );

  const checkInMinutes =
    type === "CHECK_IN"
      ? local.minutes
      : existingDay?.firstCheckInAt
        ? shiftAxisMinutes(existingDay.firstCheckInAt, local.date, timezone)
        : null;

  const inTraining = employee.trainingPlans.some((p) => p.startDate <= now && p.endDate >= now);

  const evaluation = evaluateDay(
    {
      dayKind: calendar.days[0]?.kind ?? "WORKING",
      checkInMinutes,
      checkOutMinutes: type === "CHECK_OUT" ? local.minutes : null,
      training: inTraining,
      // A check-in leaves the day open, so it scores CHECKED_IN rather than
      // whatever `missingCheckout` says. Measured on one live organisation:
      // every check-in read "half day" from the moment the person arrived and
      // the owner corrected the rows by hand each evening. The rule for a
      // check-out that never comes is applied by the close of the day.
      open: type === "CHECK_IN",
    },
    rules,
  );

  const day = await tx.attendanceDay.upsert({
    where: { employeeId_date: { employeeId: employee.id, date: dayStart } },
    create: {
      organizationId,
      employeeId: employee.id,
      date: dayStart,
      status: evaluation.status,
      systemStatus: evaluation.status,
      firstCheckInAt: type === "CHECK_IN" ? now : null,
      lastCheckOutAt: type === "CHECK_OUT" ? now : null,
      workedMinutes: evaluation.workedMinutes,
      lateMinutes: evaluation.lateMinutes,
      earlyLeaveMinutes: evaluation.earlyLeaveMinutes,
      overtimeMinutes: evaluation.overtimeMinutes,
      isExtraDay: evaluation.isExtraDay,
      source: facts.source,
    },
    update: {
      // An admin override is never silently recomputed away.
      ...(existingDay?.overriddenAt ? {} : { status: evaluation.status }),
      systemStatus: evaluation.status,
      ...(type === "CHECK_IN" ? { firstCheckInAt: now } : { lastCheckOutAt: now }),
      workedMinutes: evaluation.workedMinutes,
      lateMinutes: evaluation.lateMinutes,
      earlyLeaveMinutes: evaluation.earlyLeaveMinutes,
      overtimeMinutes: evaluation.overtimeMinutes,
      isExtraDay: evaluation.isExtraDay,
    },
  });

  const event = await tx.attendanceEvent.create({
    data: {
      organizationId,
      employeeId: employee.id,
      attendanceDayId: day.id,
      type,
      occurredAt: now,
      latitude: facts.latitude ?? null,
      longitude: facts.longitude ?? null,
      // Recorded on every mark whether or not it was gated on: it is what a
      // reviewer reads beside a rough distance. The column is an integer and
      // the route accepts any number, so it is rounded here rather than
      // trusted to be whole.
      accuracyMeters: wholeMetres(facts.accuracyMeters),
      distanceMeters: facts.distanceMeters,
      withinGeofence: facts.withinGeofence,
      workLocationId: facts.workLocationId,
      selfieKey: facts.selfieKey,
      faceMatchScore: facts.faceMatchScore,
      faceMatchPassed: facts.faceMatchPassed,
      faceMatchReason: facts.faceMatchReason,
      flaggedForReview: facts.flaggedForReview,
      deviceInfo: (facts.deviceInfo ?? undefined) as object | undefined,
      ipAddress: facts.ipAddress ?? null,
      source: facts.source,
      kioskBypass: facts.kioskBypass ?? null,
      bypassById: facts.bypassById ?? null,
      note: [facts.note, replacedCheckOut].filter(Boolean).join(". ") || null,
    },
  });

  return {
    eventId: event.id,
    dayId: day.id,
    status: evaluation.status,
    workedMinutes: evaluation.workedMinutes,
    lateMinutes: evaluation.lateMinutes,
  };
}

/**
 * A stored instant, as minutes on the row's own shift-day axis.
 *
 * A 00:30 arrival on a 22:00 shift sits on the previous date's row (see
 * `shiftDayFor`). Read back as a plain clock it is minute 30 -- before the
 * shift started -- so the check-out scored no lateness and a day's worth of
 * extra minutes. On the row's axis it is minute 1470.
 */
function shiftAxisMinutes(instant: Date, rowDate: DateOnly, timezone: string): number {
  const local = instantInZone(instant, timezone);
  return local.date > rowDate ? local.minutes + 1440 : local.minutes;
}

/** An `Int` column; a phone reports 12.7 and Prisma refuses the write. */
export function wholeMetres(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/**
 * What the detector saw, for the audit row of either mark path.
 *
 * Sixteen "several faces" refusals in one week on the live instance were
 * bystanders behind the counter, and the audit could not say so. The engine
 * reports `bystanderCount` once it tracks the primary face rather than the
 * highest-scoring detection; read through an optional so an engine build
 * from before that counts nobody as background rather than failing to type.
 */
export function facesSeen(candidate: FaceCandidate & { bystanderCount?: number | null }): {
  faceCount: number;
  bystanders: number;
} {
  return { faceCount: candidate.faceCount, bystanders: candidate.bystanderCount ?? 0 };
}

function formatLocal(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: isValidTimeZone(timezone) ? timezone : FALLBACK_TIME_ZONE,
  }).format(date);
}
