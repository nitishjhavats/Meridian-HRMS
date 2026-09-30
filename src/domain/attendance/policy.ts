/**
 * Attendance policy — every threshold an organisation can tune, plus the pure
 * function that turns raw check-in/out times into a day status.
 *
 * Nothing here is hard-coded per organisation: the whole shape is stored as an
 * `OrgPolicyVersion` row of kind ATTENDANCE and passed in.
 */

import { z } from "zod";
import type { DayKind } from "../calendar";
import { type DateOnly, addDays } from "../date";

export type AttendanceStatus =
  | "FULL_DAY"
  | "HALF_DAY"
  | "ABSENT"
  | "WEEK_OFF"
  | "DAY_OFF"
  | "HOLIDAY"
  | "EXTRA_DAY"
  | "PAID_LEAVE"
  | "UNPAID_LEAVE"
  | "TRAINING_DAY"
  | "ON_DUTY"
  | "NOT_MARKED"
  /**
   * Checked in, not yet checked out, and the day is still open.
   *
   * Before this existed, a check-in was scored at once as if the check-out had
   * already failed to come: with the shipped `missingCheckout: "HALF_DAY"`,
   * every person read "half day" from the moment they arrived, and one owner
   * corrected those rows by hand every evening. This is the honest state for
   * the hours in between. It is never final -- a check-out replaces it, and
   * the nightly close settles what is left through `missingCheckout`
   * (`settleOpenDay`). Payroll never sees it.
   */
  | "CHECKED_IN";

export interface ShiftConfig {
  /** "HH:MM" in the organisation's timezone. */
  start: string;
  end: string;
  breakMinutes: number;
  crossesMidnight: boolean;
}

export interface AttendancePolicy {
  shift: ShiftConfig;
  /** Arrivals within grace are on time. */
  graceMinutes: number;
  /** Beyond this many minutes past shift start the day is flagged LATE. */
  lateAfterMinutes: number;
  /** Beyond this the day becomes HALF_DAY regardless of hours worked. */
  halfDayAfterMinutes: number;
  /** Leaving this many minutes before shift end counts as early departure. */
  earlyLeaveBeforeMinutes: number;
  /**
   * Minimum worked minutes to earn a full day.
   *
   * Keep this *below* the nominal shift duration. If it equals the shift exactly,
   * every late arrival silently becomes a half day and the grace period, the late
   * threshold and the half-day threshold all stop meaning anything.
   */
  minMinutesFullDay: number;
  /** Minimum worked minutes to earn a half day; below this the day is ABSENT. */
  minMinutesHalfDay: number;
  /** A missing check-out is either ignored, half-day, or absent. */
  missingCheckout: "IGNORE" | "HALF_DAY" | "ABSENT";
  /** Auto-close an open day at shift end instead of leaving it open. */
  autoCheckoutAtShiftEnd: boolean;
  /** Allow marking attendance outside the shift window at all. */
  checkInWindow: { openMinutesBeforeStart: number; closeMinutesAfterEnd: number };
  requireGps: boolean;
  requireSelfie: boolean;
  defaultRadiusMeters: number;
  /**
   * Whether a coarse GPS reading is refused before the distance is measured.
   *
   * Off for everybody. This used to be a constant -- a third of the radius,
   * never more than 35 m -- with no switch, and an old phone that can only say
   * "somewhere within ±60 m" was turned away at the gate however close it
   * stood. The distance is the fact that matters; the accuracy is recorded on
   * every mark and shown beside it, so a reviewer can see when a reading was
   * rough. An organisation that wants the gate back turns it on here.
   */
  gpsAccuracy: { enforce: boolean; maxMeters: number };
  /**
   * Refuse a mark when the employee has no work location to measure against.
   *
   * `requireGps` only ever forced coordinates to be *present*. With no work
   * location attached — which is every employee in a brand-new organisation,
   * because provisioning deliberately creates none — the coordinates were
   * accepted and never compared to anything, so attendance could be marked from
   * anywhere on earth and nothing said so.
   *
   * **On by default now.** GPS that is required but never compared is worse
   * than no GPS at all -- it produces a record that looks verified and is not.
   *
   * The danger it was off for is real and is handled elsewhere rather than by
   * leaving the hole open: `scripts/set-attendance-fence.mts` will not switch an
   * existing organisation on while any active employee is unassigned, and the
   * attendance settings screen names exactly who those people are.
   */
  requireWorkLocation: boolean;
  /**
   * Where attendance may be marked from.
   *
   * `self` is somebody's own phone, authenticated as themselves. `kiosk` is a
   * shared device standing in an office, which marks *on behalf of* whoever is
   * at the screen — a different trust model, which is why the kiosk forces face
   * matching to REQUIRED regardless of `faceMatch.mode` below.
   *
   * Both false would lock the whole organisation out, so the editor refuses it.
   */
  marking: MarkingPolicy;
  /** Work on a week-off/holiday becomes an EXTRA_DAY when at least this many minutes are worked. */
  extraDayMinMinutes: number;
  overtime: OvertimePolicy;
}

export interface MarkingPolicy {
  /** Employees may mark from their own device. */
  self: boolean;
  /** A shared office device may mark for them, after a face check. */
  kiosk: boolean;
}

export interface OvertimePolicy {
  enabled: boolean;
  /** Overtime starts only after this many minutes beyond the shift duration. */
  afterMinutesPerDay: number;
  /** Cap per day; 0 = uncapped. */
  maxMinutesPerDay: number;
  /** Only count overtime that an approver has signed off. */
  requireApproval: boolean;
}

export const DEFAULT_ATTENDANCE_POLICY: AttendancePolicy = {
  shift: { start: "09:00", end: "18:00", breakMinutes: 60, crossesMidnight: false },
  graceMinutes: 10,
  lateAfterMinutes: 15,
  halfDayAfterMinutes: 30,
  earlyLeaveBeforeMinutes: 30,
  // Shift is 9 h with a 1 h break = 480 nominal working minutes; 420 leaves an
  // hour of tolerance so grace and the late thresholds actually govern the day.
  minMinutesFullDay: 420,
  minMinutesHalfDay: 240,
  missingCheckout: "HALF_DAY",
  autoCheckoutAtShiftEnd: false,
  checkInWindow: { openMinutesBeforeStart: 180, closeMinutesAfterEnd: 300 },
  requireGps: true,
  requireSelfie: true,
  // 150 m. Tried at 100 and put back: measured on the live instance, real marks
  // land 8-65 m from the office, so 100 leaves a 65 m arrival with 35 m of room
  // -- enough on paper and not enough for a car park, a gate and a lift lobby.
  defaultRadiusMeters: 150,
  gpsAccuracy: { enforce: false, maxMeters: 35 },
  requireWorkLocation: true,
  // Today's behaviour exactly: everyone marks from their own device, and the
  // kiosk stays off until an admin deliberately turns it on.
  marking: { self: true, kiosk: false },
  extraDayMinMinutes: 240,
  overtime: {
    enabled: true,
    afterMinutesPerDay: 30,
    maxMinutesPerDay: 240,
    requireApproval: false,
  },
};

/**
 * Whether this person may mark from their own device.
 *
 * The organisation sets the rule; a single employee can be excepted from it.
 * Field staff are the reason the exception exists — an organisation that moves
 * to office-device-only would otherwise lock out everyone whose job is to be
 * somewhere else. `null` means "follow the organisation", which is what every
 * employee row says until somebody decides otherwise.
 *
 * One function so the service that enforces this and the screen that explains
 * it can never disagree about the answer.
 */
export function mayMarkFromOwnDevice(
  policy: Pick<AttendancePolicy, "marking">,
  employee: { allowSelfMarking?: boolean | null },
): boolean {
  return employee.allowSelfMarking ?? policy.marking.self;
}

export interface ArrivalExample {
  arrival: string;
  status: string;
  lateMinutes: number;
  note: string;
}

/**
 * A worked example, computed with the real `evaluateDay`.
 *
 * "Late after 15 minutes, half day after 30" is four numbers that interact; what
 * an admin actually wants to know is what happens to somebody who walks in at
 * 9:20. Deriving it from the same function that scores the real day means the
 * preview cannot drift from the behaviour.
 */
export function describeArrivals(policy: AttendancePolicy): ArrivalExample[] {
  const shift = shiftMinutes(policy);
  const offsets = [0, policy.graceMinutes + 1, policy.lateAfterMinutes + 5, policy.halfDayAfterMinutes + 5];

  const seen = new Set<number>();
  const examples: ArrivalExample[] = [];

  for (const offset of offsets) {
    if (seen.has(offset)) continue;
    seen.add(offset);

    const checkInMinutes = shift.start + offset;
    const evaluation = evaluateDay(
      { dayKind: "WORKING", checkInMinutes, checkOutMinutes: shift.end },
      policy,
    );

    const hours = Math.floor((checkInMinutes % 1440) / 60);
    const minutes = (checkInMinutes % 1440) % 60;

    examples.push({
      arrival: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
      status: evaluation.status,
      lateMinutes: evaluation.lateMinutes,
      note: evaluation.notes[0] ?? (evaluation.isLate ? "Recorded as late" : "On time"),
    });
  }

  return examples;
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The stored shape of an ATTENDANCE policy.
 *
 * Every field carries its default, so an `OrgPolicyVersion.payload` written
 * before a field existed still parses — which matters because rows predating
 * `marking` and `faceMatch` are live in production right now. That makes one
 * schema serve both directions: reads parse loosely and land on defaults, writes
 * parse the same way and then have to survive the refinements below.
 *
 * The refinements are not pedantry. Until this screen existed the only writer
 * was the seed, so a nonsensical combination was unreachable; a form makes every
 * one of them one keystroke away, and each produces a silently wrong day rather
 * than an error.
 */
const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:00 or 18:30");

export const attendancePolicySchema = z
  .object({
    shift: z
      .object({
        start: clock.default(DEFAULT_ATTENDANCE_POLICY.shift.start),
        end: clock.default(DEFAULT_ATTENDANCE_POLICY.shift.end),
        breakMinutes: z.number().int().min(0).max(480).default(DEFAULT_ATTENDANCE_POLICY.shift.breakMinutes),
        crossesMidnight: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.shift.crossesMidnight),
      })
      .default(DEFAULT_ATTENDANCE_POLICY.shift),
    graceMinutes: z.number().int().min(0).max(240).default(DEFAULT_ATTENDANCE_POLICY.graceMinutes),
    lateAfterMinutes: z.number().int().min(0).max(480).default(DEFAULT_ATTENDANCE_POLICY.lateAfterMinutes),
    halfDayAfterMinutes: z
      .number()
      .int()
      .min(0)
      .max(720)
      .default(DEFAULT_ATTENDANCE_POLICY.halfDayAfterMinutes),
    earlyLeaveBeforeMinutes: z
      .number()
      .int()
      .min(0)
      .max(480)
      .default(DEFAULT_ATTENDANCE_POLICY.earlyLeaveBeforeMinutes),
    minMinutesFullDay: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .default(DEFAULT_ATTENDANCE_POLICY.minMinutesFullDay),
    minMinutesHalfDay: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .default(DEFAULT_ATTENDANCE_POLICY.minMinutesHalfDay),
    missingCheckout: z
      .enum(["IGNORE", "HALF_DAY", "ABSENT"])
      .default(DEFAULT_ATTENDANCE_POLICY.missingCheckout),
    autoCheckoutAtShiftEnd: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.autoCheckoutAtShiftEnd),
    checkInWindow: z
      .object({
        openMinutesBeforeStart: z
          .number()
          .int()
          .min(0)
          .max(1440)
          .default(DEFAULT_ATTENDANCE_POLICY.checkInWindow.openMinutesBeforeStart),
        closeMinutesAfterEnd: z
          .number()
          .int()
          .min(0)
          .max(1440)
          .default(DEFAULT_ATTENDANCE_POLICY.checkInWindow.closeMinutesAfterEnd),
      })
      .default(DEFAULT_ATTENDANCE_POLICY.checkInWindow),
    requireGps: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.requireGps),
    requireSelfie: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.requireSelfie),
    requireWorkLocation: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.requireWorkLocation),
    defaultRadiusMeters: z
      .number()
      .int()
      .min(10)
      .max(10_000)
      .default(DEFAULT_ATTENDANCE_POLICY.defaultRadiusMeters),
    gpsAccuracy: z
      .object({
        enforce: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.gpsAccuracy.enforce),
        maxMeters: z
          .number()
          .int()
          .min(5)
          .max(500)
          .default(DEFAULT_ATTENDANCE_POLICY.gpsAccuracy.maxMeters),
      })
      .default(DEFAULT_ATTENDANCE_POLICY.gpsAccuracy),
    marking: z
      .object({
        self: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.marking.self),
        kiosk: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.marking.kiosk),
      })
      .default(DEFAULT_ATTENDANCE_POLICY.marking),
    extraDayMinMinutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(DEFAULT_ATTENDANCE_POLICY.extraDayMinMinutes),
    overtime: z
      .object({
        enabled: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.overtime.enabled),
        afterMinutesPerDay: z.number().int().min(0).max(720).default(30),
        maxMinutesPerDay: z.number().int().min(0).max(1440).default(240),
        requireApproval: z.boolean().default(DEFAULT_ATTENDANCE_POLICY.overtime.requireApproval),
      })
      .default(DEFAULT_ATTENDANCE_POLICY.overtime),
  })
  .superRefine((policy, ctx) => {
    // Both off is not a configuration, it is an outage: nobody in the
    // organisation could mark attendance at all.
    if (!policy.marking.self && !policy.marking.kiosk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["marking"],
        message:
          "Attendance has to be markable somewhere. Allow personal devices, the office device, or both.",
      });
    }

    // Thresholds must be reachable in the order they are described, or the
    // middle one silently never fires.
    if (policy.graceMinutes > policy.lateAfterMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lateAfterMinutes"],
        message: "Nobody could ever be late: the grace period is longer than the late threshold.",
      });
    }
    if (policy.lateAfterMinutes > policy.halfDayAfterMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["halfDayAfterMinutes"],
        message:
          "A late arrival would become a half day before it was ever counted as late. Raise the half-day threshold above the late one.",
      });
    }

    if (policy.minMinutesHalfDay >= policy.minMinutesFullDay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minMinutesHalfDay"],
        message: "A half day has to need fewer minutes than a full day.",
      });
    }

    // The trap this file has always warned about, now one keystroke away.
    const { duration } = shiftMinutes(policy);
    if (duration > 0 && policy.minMinutesFullDay >= duration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minMinutesFullDay"],
        message: `A full day needs fewer minutes than the shift itself (${duration}). At or above it, every late arrival silently becomes a half day and the grace, late and half-day thresholds stop meaning anything.`,
      });
    }
  });

export function safeParseAttendancePolicy(input: unknown) {
  return attendancePolicySchema.safeParse(input);
}

export interface DayInput {
  /** What the calendar says this day is, before attendance. */
  dayKind: DayKind;
  /** Minutes past midnight of the first check-in, or null if never checked in. */
  checkInMinutes: number | null;
  /** Minutes past midnight of the last check-out; may exceed 1440 for overnight shifts. */
  checkOutMinutes: number | null;
  /** Break minutes actually taken, if tracked; falls back to the shift's break. */
  breakMinutes?: number | null;
  /**
   * Leave is deliberately not an input here.
   *
   * This function used to take `leave: { paid, half }` and branch on it, and no
   * caller ever passed it — `record.ts`, its only production caller, runs when
   * somebody marks attendance, and the branch required *no* check-in, so it was
   * unreachable by construction. What an approved leave makes of a day now
   * lives in one place, `src/domain/leave/attendanceDays.ts`, which both
   * `decideLeave` and `buildPayrollInput` ask. Two functions answering the same
   * question is how a day gets paid twice.
   *
   * This function answers a different question: what do these check-in times
   * make of the day.
   */
  /** Employee is in a training period on this day. */
  training?: boolean;
  /**
   * The day is still in progress: a missing check-out is not yet a missing
   * check-out. `record.ts` passes this at check-in time; the nightly close and
   * a check-out evaluate without it, and only then does `missingCheckout`
   * apply.
   */
  open?: boolean;
}

export interface DayEvaluation {
  status: AttendanceStatus;
  workedMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
  isLate: boolean;
  isExtraDay: boolean;
  notes: string[];
}

/**
 * Shift boundaries in minutes-from-midnight, plus the nominal working minutes
 * once the break is taken out.
 *
 * Exported because the policy schema refines against `duration` and the
 * settings screen shows it back to the admin — three places computing a shift
 * length three different ways is how thresholds start disagreeing.
 */
export function shiftMinutes(policy: Pick<AttendancePolicy, "shift">): {
  start: number;
  end: number;
  duration: number;
} {
  const [sh, sm] = policy.shift.start.split(":").map(Number);
  const [eh, em] = policy.shift.end.split(":").map(Number);
  const start = (sh ?? 0) * 60 + (sm ?? 0);
  let end = (eh ?? 0) * 60 + (em ?? 0);
  if (policy.shift.crossesMidnight || end <= start) end += 1440;
  return { start, end, duration: end - start - policy.shift.breakMinutes };
}

/**
 * When attendance may be marked at all.
 *
 * Returned on an *extended* minute axis anchored to the shift's own day, which
 * is the only way the arithmetic works for every shift:
 *
 *   - an early shift pushes `opensAt` negative (09:00 opening three hours early
 *     is fine; 01:00 opening three hours early is 22:00 the previous evening);
 *   - a late shift pushes `closesAt` past 1440;
 *   - a night shift has `shiftMinutes` already carry `end` past 1440, so the
 *     window simply continues.
 *
 * The old code did none of this. It compared a raw 0-1439 clock against
 * `timeToMinutes(start) - open` and `timeToMinutes(end) + close`, so for a
 * 22:00-06:00 shift it asked for `minutes < 1200 || minutes > 600` -- true at
 * every minute of the day. Every night-shift check-in was refused, and the
 * refusal quoted a range that could not be satisfied.
 */
export interface MarkingWindow {
  /** Minutes from the shift day's local midnight. May be negative. */
  opensAt: number;
  /** Minutes from the same midnight. May exceed 1440. */
  closesAt: number;
}

export function markingWindow(
  policy: Pick<AttendancePolicy, "shift" | "checkInWindow">,
): MarkingWindow {
  const { start, end } = shiftMinutes(policy);
  return {
    opensAt: start - policy.checkInWindow.openMinutesBeforeStart,
    closesAt: end + policy.checkInWindow.closeMinutesAfterEnd,
  };
}

/**
 * Whether a wall-clock minute falls inside the window.
 *
 * `minutes` is 0-1439 as a person reads a clock, so it is tried at three
 * offsets: today, yesterday and tomorrow relative to the shift's own day. That
 * is what lets 02:00 satisfy a window running 19:00 to 11:00, without the
 * caller having to know which calendar day the shift belongs to.
 */
export function isWithinMarkingWindow(
  policy: Pick<AttendancePolicy, "shift" | "checkInWindow">,
  minutes: number,
): boolean {
  const { opensAt, closesAt } = markingWindow(policy);
  // A window a full day wide or wider is always open. Worth saying explicitly:
  // the offset test below would also return true, but only by luck of the three
  // candidates, and an admin who sets 1440/1440 means "never refuse".
  if (closesAt - opensAt >= 1440) return true;
  return [minutes - 1440, minutes, minutes + 1440].some(
    (candidate) => candidate >= opensAt && candidate <= closesAt,
  );
}

/** The window as two clock strings, for the screen and for the refusal. */
export function describeMarkingWindow(
  policy: Pick<AttendancePolicy, "shift" | "checkInWindow">,
): { opens: string; closes: string } {
  const { opensAt, closesAt } = markingWindow(policy);
  return { opens: windowClock(opensAt), closes: windowClock(closesAt) };
}

/** Minutes on the extended axis to a wall clock a person recognises. */
function windowClock(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Turns raw times into a day status. Pure, so the same day always evaluates the
 * same way — an admin override is stored separately and never re-derived.
 */
export function evaluateDay(input: DayInput, policy: AttendancePolicy): DayEvaluation {
  const notes: string[] = [];
  const shift = shiftMinutes(policy);
  const hasIn = input.checkInMinutes != null;
  const hasOut = input.checkOutMinutes != null;

  const breakTaken = input.breakMinutes ?? policy.shift.breakMinutes;
  let workedMinutes = 0;
  if (hasIn && hasOut) {
    let out = input.checkOutMinutes as number;
    const inn = input.checkInMinutes as number;
    if (out < inn) out += 1440; // crossed midnight
    workedMinutes = Math.max(0, out - inn - breakTaken);
  }

  const base: DayEvaluation = {
    status: "NOT_MARKED",
    workedMinutes,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    isLate: false,
    isExtraDay: false,
    notes,
  };

  // --- Week off / holiday: presence turns the day into an extra day.
  if (input.dayKind === "WEEK_OFF" || input.dayKind === "HOLIDAY") {
    const restStatus: AttendanceStatus = input.dayKind === "WEEK_OFF" ? "WEEK_OFF" : "HOLIDAY";
    if (!hasIn) return { ...base, status: restStatus };
    if (input.open && !hasOut) {
      return { ...base, status: "CHECKED_IN", notes: [...notes, "Checked in, not yet checked out"] };
    }
    if (workedMinutes >= policy.extraDayMinMinutes || (hasIn && !hasOut)) {
      const overtime = computeOvertime(workedMinutes, shift.duration, policy.overtime);
      return {
        ...base,
        status: "EXTRA_DAY",
        isExtraDay: true,
        overtimeMinutes: overtime,
        notes: [...notes, `Worked on a ${input.dayKind === "WEEK_OFF" ? "week off" : "holiday"}`],
      };
    }
    return {
      ...base,
      status: restStatus,
      notes: [...notes, "Worked less than the extra-day threshold"],
    };
  }

  // --- Ordinary working day.
  if (!hasIn) {
    return { ...base, status: "ABSENT", notes: [...notes, "No check-in recorded"] };
  }

  const lateBy = Math.max(0, (input.checkInMinutes as number) - shift.start);
  const lateMinutes = lateBy > policy.graceMinutes ? lateBy : 0;
  const isLate = lateBy > policy.lateAfterMinutes;
  if (isLate) notes.push(`Late by ${lateBy} minutes`);

  let earlyLeaveMinutes = 0;
  if (hasOut) {
    let out = input.checkOutMinutes as number;
    if (out < (input.checkInMinutes as number)) out += 1440;
    const early = Math.max(0, shift.end - out);
    if (early > policy.earlyLeaveBeforeMinutes) {
      earlyLeaveMinutes = early;
      notes.push(`Left ${early} minutes early`);
    }
  }

  // Still at work: lateness is known, nothing else is. The verdict on a
  // check-out that never comes belongs to the close of the day, not its start.
  if (input.open && !hasOut) {
    return {
      ...base,
      status: "CHECKED_IN",
      lateMinutes,
      isLate,
      notes: [...notes, "Checked in, not yet checked out"],
    };
  }

  let status: AttendanceStatus;
  if (!hasOut) {
    status =
      policy.missingCheckout === "ABSENT"
        ? "ABSENT"
        : policy.missingCheckout === "HALF_DAY"
          ? "HALF_DAY"
          : "FULL_DAY";
    notes.push("No check-out recorded");
  } else if (workedMinutes < policy.minMinutesHalfDay) {
    status = "ABSENT";
    notes.push("Worked less than the half-day minimum");
  } else if (workedMinutes < policy.minMinutesFullDay) {
    status = "HALF_DAY";
  } else if (lateBy > policy.halfDayAfterMinutes) {
    status = "HALF_DAY";
    notes.push(`Arrival beyond the ${policy.halfDayAfterMinutes}-minute half-day threshold`);
  } else {
    status = "FULL_DAY";
  }

  if (input.training && status === "FULL_DAY") status = "TRAINING_DAY";

  return {
    ...base,
    status,
    lateMinutes,
    earlyLeaveMinutes,
    isLate,
    overtimeMinutes: computeOvertime(workedMinutes, shift.duration, policy.overtime),
    notes,
  };
}

export function computeOvertime(
  workedMinutes: number,
  shiftDuration: number,
  policy: OvertimePolicy,
): number {
  if (!policy.enabled) return 0;
  const extra = workedMinutes - shiftDuration - policy.afterMinutesPerDay;
  if (extra <= 0) return 0;
  const raw = workedMinutes - shiftDuration;
  return policy.maxMinutesPerDay > 0 ? Math.min(raw, policy.maxMinutesPerDay) : raw;
}

/**
 * What an open day becomes once nobody is going to check out of it.
 *
 * The same rule `evaluateDay` applies to a closed day with no check-out, made
 * available on its own for the two places that meet a `CHECKED_IN` row after
 * the fact: the nightly close, and payroll -- which must never carry an
 * in-progress status into a ledger. Every other status passes through.
 */
export function settleOpenDay(
  status: AttendanceStatus,
  missingCheckout: AttendancePolicy["missingCheckout"],
  dayKind: DayKind = "WORKING",
): AttendanceStatus {
  if (status !== "CHECKED_IN") return status;
  // A check-in on a rest day with no check-out is an extra day, exactly as
  // `evaluateDay` scores it at the close; the missing-checkout rule is a
  // working-day rule.
  if (dayKind === "WEEK_OFF" || dayKind === "HOLIDAY") return "EXTRA_DAY";
  return missingCheckout === "ABSENT" ? "ABSENT" : missingCheckout === "HALF_DAY" ? "HALF_DAY" : "FULL_DAY";
}

/**
 * The shift day a wall-clock moment belongs to.
 *
 * Attendance rows are keyed by date, and until now the date was the calendar
 * date of the moment somebody pressed the button. For a shift that ends on
 * its own day that is the same thing. For a 22:00-06:00 shift it is not: the
 * 06:00 check-out fell on the next date, found no check-in there, and was
 * refused with "you have not checked in today" -- every night, for anybody
 * on nights. An early-morning moment still inside the previous shift day's
 * marking window belongs to that day, on the extended minute axis the window
 * itself uses (so 06:00 is minute 1800 of the shift day, and lateness and
 * worked minutes come out right).
 */
export function shiftDayFor(
  policy: Pick<AttendancePolicy, "shift" | "checkInWindow">,
  local: { date: DateOnly; minutes: number },
): { date: DateOnly; minutes: number } {
  const { end } = shiftMinutes(policy);
  if (end <= 1440) return local;
  const { closesAt } = markingWindow(policy);
  if (local.minutes < closesAt - 1440) {
    return { date: addDays(local.date, -1), minutes: local.minutes + 1440 };
  }
  return local;
}

/**
 * How soon after a check-in a check-out is believed.
 *
 * Measured three times in four days on one live organisation: a check-out
 * 9, 9 and 51 seconds after the check-in, each scoring the day ABSENT with
 * nothing worked. Nobody leaves nine seconds after arriving; the button had
 * turned into "Check out" and was pressed again. Under five minutes it is a
 * mistake, and the honest answer is to say so rather than record it.
 */
export const MIN_MINUTES_BEFORE_CHECKOUT = 5;

export function checkoutTooSoon(
  firstCheckInAt: Date,
  now: Date,
): { tooSoon: boolean; minutesSince: number } {
  const minutesSince = Math.max(0, Math.floor((now.getTime() - firstCheckInAt.getTime()) / 60_000));
  return { tooSoon: minutesSince < MIN_MINUTES_BEFORE_CHECKOUT, minutesSince };
}

/** Statuses that mean "the employee was at work" for headcount widgets. */
export const PRESENT_STATUSES: readonly AttendanceStatus[] = [
  "FULL_DAY",
  "HALF_DAY",
  "EXTRA_DAY",
  "TRAINING_DAY",
  "ON_DUTY",
  "CHECKED_IN",
];

export const STATUS_LABELS: Record<AttendanceStatus, string> = {
  FULL_DAY: "Full day",
  HALF_DAY: "Half day",
  ABSENT: "Absent",
  WEEK_OFF: "Week off",
  DAY_OFF: "Day off",
  HOLIDAY: "Holiday",
  EXTRA_DAY: "Extra day",
  PAID_LEAVE: "Paid leave",
  UNPAID_LEAVE: "Unpaid leave",
  TRAINING_DAY: "Training day",
  ON_DUTY: "On duty",
  NOT_MARKED: "Not marked",
  CHECKED_IN: "Checked in",
};
