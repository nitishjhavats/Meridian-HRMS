import type { AttendanceStatus } from "@prisma/client";
import { FALLBACK_TIME_ZONE, isValidTimeZone } from "@/domain/date";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, requireWritable } from "@/lib/auth/guard";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { enforce } from "@/lib/ratelimit";
import {
  COMPRESSION,
  IMAGE_CONSTRAINTS,
  buildKey,
  compressImage,
  storage,
  validateUpload,
} from "@/lib/storage";
import { MAX_SEQUENCE_FRAMES, faceEngine } from "@/lib/face/engine";
import { checkGeofence, type Coordinates } from "@/domain/attendance/geo";
import {
  describeMarkingWindow,
  isWithinMarkingWindow,
  mayMarkFromOwnDevice,
  shiftDayFor,
} from "@/domain/attendance/policy";
import { assertCheckoutNotTooSoon, facesSeen, recordAttendance, wholeMetres } from "./record";
import {
  evaluateFaceMatch,
  type FaceMatchVerdict,
  type FaceRejectReason,
} from "@/domain/attendance/faceMatch";
import { instantInZone, type DateOnly } from "@/domain/date";
import { type AttendanceRules, getAttendanceRules } from "../policy";
import { loadEnrolledDescriptors } from "../employees/faceEnrolment";

/**
 * Marking attendance.
 *
 * Three things are verified, all server-side, in this order:
 *
 *   1. **Where** — the coordinates are inside the configured radius. The browser
 *      sends latitude/longitude; the distance is computed here.
 *   2. **Who** — the selfie is matched against the employee's enrolled reference
 *      photo. The image is uploaded; the descriptor and the verdict are produced
 *      here. A client can never assert that it matched.
 *   3. **When** — the timestamp is the server's clock, not the device's, so a
 *      phone with its date wound back cannot backdate a punch.
 */

export interface MarkAttendanceInput {
  type: "CHECK_IN" | "CHECK_OUT";
  coordinates?: Coordinates | null;
  selfie?: { data: Buffer; fileName: string; mimeType: string } | null;
  /**
   * The rest of the burst the selfie came from, in capture order.
   *
   * Liveness needs a sequence -- a single frame cannot tell a person from a
   * photograph of that person. These are used for the blink check and then
   * discarded: only `selfie` is ever stored, because keeping eight frames of
   * somebody's face per check-in is a great deal more biometric data than the
   * product needs, and it is not evidence of anything the stored frame is not.
   */
  frames?: { data: Buffer; fileName: string; mimeType: string }[] | null;
  deviceInfo?: Record<string, unknown> | null;
  note?: string;
  ipAddress?: string | null;
  /**
   * "I have tried enough times. Mark it and let somebody look at it."
   *
   * The screen offers this only after the refusals a reason is worth --
   * `reviewAfterAttempts` -- because two more tries in better light genuinely
   * fixes a dark frame and another attempt often lands a match. After the
   * count the organisation set it does not, and a person standing in a
   * corridor at nine in the morning has run out of things to do differently.
   *
   * The server cannot verify the count, and does not try to. What it can
   * guarantee is that a mark taken this way is *always* flagged, never counted
   * as verified, and lands in a queue where rejecting it now removes the day.
   * The escape buys a person their morning; it does not buy them a verified
   * attendance record.
   */
  acceptForReview?: boolean;
}

export interface MarkAttendanceResult {
  eventId: string;
  date: DateOnly;
  type: "CHECK_IN" | "CHECK_OUT";
  occurredAt: Date;
  status: AttendanceStatus;
  workedMinutes: number;
  lateMinutes: number;
  distanceMeters: number | null;
  face: {
    checked: boolean;
    matched: boolean | null;
    confidence: "STRONG" | "GOOD" | "WEAK" | "NONE";
    message?: string;
    flagged: boolean;
    /** Every doubt recorded against this mark, for the screen and the queue. */
    reasons: FaceRejectReason[];
  };
  /**
   * Set when this call re-checked a mark that was already waiting for review.
   *
   * `cleared` means the retry matched and the doubt is gone; `pending` means it
   * did not and the mark is still waiting. The day is untouched either way --
   * the person already marked it.
   */
  reverified?: "cleared" | "pending";
  warnings: string[];
}

/**
 * Coordinates as they are *stored*, which is coarser than as they are checked.
 *
 * The column is `Decimal(10, 7)` — about 1.1 cm — and the browser's reading was
 * written into it unrounded. A geofence is measured in tens of metres, so that
 * precision buys nothing and keeps a centimetre-accurate record of where an
 * employee stood, every working day, for the life of the row.
 *
 * Five decimals is about 1.1 m: far inside any fence this product will ever
 * enforce, and no longer a map reference to somebody's desk. The fence itself
 * is still computed from the full reading before this is applied.
 */
const STORED_COORDINATE_DECIMALS = 5;

function coarsen(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(STORED_COORDINATE_DECIMALS));
}

/**
 * The widest GPS accuracy this organisation will act on, or `null` for no
 * ceiling at all.
 *
 * Radius only, for everybody, unless the organisation switched the gate on.
 * The ceiling used to be a constant of the fence (35 m at a 300 m radius on
 * the live instance) and it turned away old phones at the counter and
 * recorded nothing, so the owner saw blanks rather than refusals. One
 * function so the panel and the server cannot disagree about whether there
 * is a ceiling.
 */
function accuracyCeiling(rules: Pick<AttendanceRules, "gpsAccuracy">): number | null {
  return rules.gpsAccuracy.enforce ? rules.gpsAccuracy.maxMeters : null;
}

/**
 * How long after a flagged check-out a second check-out is a retake of it.
 *
 * A flagged mark is re-checked rather than re-made, so the person can try
 * again in better light -- and for a check-in that is always right, because
 * the arrival time stands whatever the photo did. A check-out is different:
 * "check out again, the later time counts" is a promise `recordAttendance`
 * keeps, and the re-check branch was catching *every* later check-out on a
 * day whose earlier one was flagged, so somebody who left at lunch under a
 * doubted photo and came back to leave at seven had the seven o'clock refused
 * as a photo retake and the day scored to lunchtime. Within ten minutes it is
 * the same departure and a better photo; after that it is a later departure.
 */
export const RETAKE_WINDOW_MINUTES = 10;

export async function markAttendance(
  ctx: AuthContext,
  input: MarkAttendanceInput,
): Promise<MarkAttendanceResult> {
  requireOrg(ctx);
  requirePermission(ctx, "attendance.mark.self");
  requireModule(ctx, "attendance");
  requireWritable(ctx);

  if (!ctx.employeeId) {
    throw new ForbiddenError("Your login is not linked to an employee record.");
  }
  await enforce("attendanceMark", `${ctx.employeeId}`);

  const employee = await prisma.employee.findUnique({
    where: { id: ctx.employeeId },
    select: {
      id: true,
      organizationId: true,
      firstName: true,
      active: true,
      employmentState: true,
      departmentId: true,
      allowSelfMarking: true,
      workLocation: {
        select: {
          id: true,
          name: true,
          latitude: true,
          longitude: true,
          radiusMeters: true,
          requireGps: true,
          requireSelfie: true,
          active: true,
        },
      },
      weeklyOffPattern: { select: { config: true } },
      // The person's own rest days sit above the pattern; carried here so the
      // resolver does not have to go back for them inside the transaction.
      weeklyOffConfig: true,
      trainingPlans: { select: { startDate: true, endDate: true } },
    },
  });

  if (!employee || employee.organizationId !== ctx.organizationId) {
    throw new NotFoundError("Your employee record");
  }
  if (!employee.active || ["RESIGNED", "TERMINATED", "INACTIVE"].includes(employee.employmentState)) {
    throw new ForbiddenError("Your employment record is not active, so attendance cannot be marked.");
  }

  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const wallClock = instantInZone(now, timezone);
  const rules = await getAttendanceRules(ctx, wallClock.date);
  /**
   * The attendance day this moment belongs to, which is not always today.
   *
   * Rows are keyed by date, and the date used to be the calendar date of the
   * press. On a 22:00-06:00 shift the 06:00 check-out therefore fell on the
   * next date, found no check-in there, and was refused with "you have not
   * checked in today" -- every night, for everybody on nights. `shiftDayFor`
   * puts an early-morning moment still inside the previous shift day's
   * window on that day, at minute 1440+, so the window test, the row lookup
   * and the evaluation all see one day.
   */
  const local = shiftDayFor(rules, wallClock);
  const warnings: string[] = [];

  // Where this organisation allows attendance to be marked. This is the security
  // boundary, not the panel that hides the button: an organisation that has moved
  // to the office device is relying on this to mean it.
  if (!mayMarkFromOwnDevice(rules, employee)) {
    throw new ForbiddenError(
      "Your organisation records attendance on the office device. Ask an administrator if you need to mark it from your own phone.",
    );
  }

  // ---- 1. where
  const location = employee.workLocation;
  let distanceMeters: number | null = null;
  /**
   * Whether a fence was actually measured against, as opposed to coordinates
   * merely arriving. These are not the same thing and the record used to say
   * they were — `withinGeofence` was written as `distanceMeters != null`, so a
   * mark with no work location at all came out looking like a failed fence
   * check rather than an absent one.
   */
  let fencePassed = false;

  if (location?.active && (location.requireGps || rules.requireGps)) {
    const fence = {
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      radiusMeters: location.radiusMeters || rules.defaultRadiusMeters,
    };
    const geo = checkGeofence(input.coordinates, fence, { maxAccuracyMeters: accuracyCeiling(rules) });
    distanceMeters = geo.distanceMeters;
    if (!geo.ok) throw new ValidationError(geo.message ?? "You are not at the office.");
    fencePassed = true;
  } else if (rules.requireWorkLocation) {
    // The organisation has said attendance must be provably at a place. Without
    // a location there is nothing to prove it against, so this refuses rather
    // than waving it through.
    throw new ValidationError(
      location
        ? "The work location you are assigned to has been switched off. Ask an administrator to set one."
        : "You are not assigned to a work location yet, and your organisation requires one. Ask an administrator.",
    );
  } else if (rules.requireGps && !input.coordinates) {
    throw new ValidationError(
      "Location is required to mark attendance. Please enable GPS and try again.",
    );
  }

  // ---- shift window
  //
  // Two things changed here and both were defects rather than preferences.
  //
  // It used to guard on `input.type === "CHECK_IN"`, so a check-out was
  // accepted at any hour of any day -- a window enforced on one half of a pair
  // is not a window. And it did the arithmetic on a raw 0-1439 clock, which for
  // a shift crossing midnight asked for `minutes < 1200 || minutes > 600` and
  // was therefore true at every minute of the day: every night-shift check-in
  // was refused, and the refusal quoted a range nobody could satisfy.
  //
  // `isWithinMarkingWindow` works on the shift's own extended axis, so an early
  // shift may open the previous evening and a late one close after midnight.
  if (!isWithinMarkingWindow(rules, local.minutes)) {
    const window = describeMarkingWindow(rules);
    throw new ValidationError(
      `${input.type === "CHECK_IN" ? "Check-in" : "Check-out"} is open between ${clockLabel(window.opens)} and ${clockLabel(window.closes)}. Ask your manager to record it for you.`,
    );
  }

  // ---- a check-out that cannot be one yet
  //
  // Asked here, before a selfie is stored or the engine runs, and asked again
  // inside the transaction where the answer counts. Three check-outs 9-60 s
  // after the check-in on one live organisation each scored the day ABSENT
  // with nothing worked; the button had changed and been pressed twice.
  if (input.type === "CHECK_OUT") {
    const today = await prisma.attendanceDay.findUnique({
      where: { employeeId_date: { employeeId: employee.id, date: new Date(`${local.date}T00:00:00.000Z`) } },
      select: { firstCheckInAt: true },
    });
    assertCheckoutNotTooSoon(today, now, "self", employee.firstName);
  }

  // ---- 2. who
  // A work location may *tighten* the organisation's rule and never loosen it.
  // `??` let one location switch selfies off against an organisation policy
  // that required them -- which is a security setting being overridden by a
  // row an office manager can edit. The GPS check above is already an `||`;
  // this now matches it.
  const selfieRequired = rules.requireSelfie || location?.requireSelfie === true;
  if (selfieRequired && !input.selfie) {
    throw new ValidationError("A photo is required to mark attendance.");
  }

  let selfieKey: string | null = null;
  let face: FaceMatchVerdict = {
    outcome: "ACCEPTED",
    allowed: true,
    matched: null,
    score: null,
    reasons: [],
    flagForReview: false,
    mode: rules.faceMatch.mode,
    reviewAfterAttempts: null,
  };
  // Null when nothing was detected at all (matching off, or no selfie): the
  // audit row can then tell "no engine" from "one face".
  let faces: { faceCount: number; bystanders: number } | null = null;

  if (input.selfie) {
    validateUpload(input.selfie.data, input.selfie.mimeType, input.selfie.fileName, IMAGE_CONSTRAINTS);

    // Compressed on the way in: a phone selfie arrives at 3–6 MB and is stored
    // at roughly 60–120 KB. Re-encoding also strips the EXIF block, which
    // otherwise smuggles a second copy of the GPS fix into the image itself.
    const compressed = await compressImage(input.selfie.data, COMPRESSION.selfie);

    selfieKey = buildKey(ctx.organizationId, "selfies", compressed.extension);

    if (rules.faceMatch.mode !== "OFF") {
      /**
       * The burst, with the stored frame in it and in its right place.
       *
       * The client sends the frames it captured and names which one it kept;
       * feeding the engine the same set means the descriptor it picks is one
       * the admin can actually look at afterwards. A client that sends a single
       * frame still works -- `describeSequence` falls through to `describe`,
       * and the blink comes back `null`, which records rather than refuses.
       */
      const burst = (input.frames?.length ? input.frames : [input.selfie])
        .slice(0, MAX_SEQUENCE_FRAMES)
        .map((frame) => {
          // Each frame is an upload like any other, and is checked like one.
          validateUpload(frame.data, frame.mimeType, frame.fileName, IMAGE_CONSTRAINTS);
          return frame.data;
        });

      const [candidate, references] = await Promise.all([
        faceEngine().describeSequence(burst),
        loadEnrolledDescriptors(employee.id),
      ]);
      face = evaluateFaceMatch(candidate, references, rules.faceMatch);
      faces = facesSeen(candidate);

      // The photo is stored even on a refusal — that is exactly the evidence an
      // admin needs when someone disputes it.
      await storage().put(selfieKey, compressed.data, compressed.mimeType, {
        organizationId: ctx.organizationId,
        kind: "selfies",
      });

      /**
       * The person has run out of tries and said so.
       *
       * Turning a refusal into a recorded, flagged mark is the whole of the
       * "process na ruke" change. It is allowed only for reasons that offer a
       * way out at all -- `reviewAfterAttempts` returns `null` for a policy
       * that means to block -- so an organisation on `onMismatch: "BLOCK"`
       * still has a closed door.
       */
      if (!face.allowed && input.acceptForReview && face.reviewAfterAttempts !== null) {
        face = {
          ...face,
          outcome: "REVIEW",
          allowed: true,
          flagForReview: true,
          message: "Marked without verification. An administrator will confirm it.",
        };
      }

      if (!face.allowed) {
        await recordRejectedAttempt(ctx, employee.id, input, selfieKey, face, {
          distanceMeters,
          passed: fencePassed,
          faces,
        });
        // The reason and the number of tries travel with the refusal, so the
        // screen can offer the right way out -- another go at a dark frame, and
        // after that a mark that somebody will look at -- instead of a message
        // the employee can only re-read.
        throw new ValidationError(face.message ?? "That photo could not be verified.", {
          face: face.reason ?? "NO_MATCH",
          reviewAfterAttempts: face.reviewAfterAttempts,
        });
      }
      if (face.message) warnings.push(face.message);
    } else {
      await storage().put(selfieKey, compressed.data, compressed.mimeType, {
        organizationId: ctx.organizationId,
        kind: "selfies",
      });
    }
  }

  /**
   * ---- 2b. the second go at a mark that is already waiting
   *
   * "par face na match rahe tab tak retry kar sakta hai log."
   *
   * The moment a doubted mark is *recorded* rather than refused, retrying stops
   * working: `recordAttendance` sees a check-in time already on the day and
   * throws "You already checked in at 09:14". The person is told their mark
   * went through, then told they cannot try again -- which is a worse place to
   * be than the refusal this round set out to remove.
   *
   * So a second photo of the same kind, on a day whose mark is still waiting,
   * re-checks that mark instead of trying to make a new one. It never touches
   * the day: they marked it, and the time stands. If the face matches this
   * time the doubt is cleared on the spot and the queue is one shorter.
   *
   * For a check-in, always: the arrival time is the arrival time. For a
   * check-out, only a retake -- the pending one within `RETAKE_WINDOW_MINUTES`
   * of now. A later check-out is a later departure, and it falls through to
   * `recordAttendance`, which replaces the time; the flagged event stays in
   * the queue for whoever is looking at it.
   */
  const pending = await findPendingMark(ctx, employee.id, local.date, input.type);
  const isRetake =
    pending !== null &&
    (input.type === "CHECK_IN" ||
      now.getTime() - pending.occurredAt.getTime() <= RETAKE_WINDOW_MINUTES * 60_000);
  if (pending && isRetake && input.selfie) {
    return await reverifyMark(ctx, pending, {
      face,
      selfieKey,
      distanceMeters,
      threshold: rules.faceMatch.threshold,
      checked: rules.faceMatch.mode !== "OFF",
      warnings,
    });
  }

  // ---- 3. the day, written the same way a kiosk writes it
  const result = await prisma.$transaction((tx) =>
    recordAttendance(tx, ctx, {
      employee,
      type: input.type,
      now,
      timezone,
      local,
      rules,
      subject: "self",
      facts: {
        latitude: coarsen(input.coordinates?.latitude),
        longitude: coarsen(input.coordinates?.longitude),
        accuracyMeters: input.coordinates?.accuracyMeters ?? null,
        distanceMeters,
        withinGeofence: fencePassed,
        workLocationId: location?.id ?? null,
        selfieKey,
        faceMatchScore: face.score,
        faceMatchPassed: face.matched,
        faceMatchReason: face.reason ?? null,
        flaggedForReview: face.flagForReview,
        deviceInfo: input.deviceInfo ?? null,
        ipAddress: input.ipAddress ?? null,
        source: "SELF_GPS",
        note: input.note ?? null,
      },
    }),
  );

  await writeAudit(ctx, {
    action: "attendance.marked",
    entityType: "AttendanceEvent",
    entityId: result.eventId,
    metadata: {
      type: input.type,
      status: result.status,
      distanceMeters,
      accuracyMeters: wholeMetres(input.coordinates?.accuracyMeters),
      faceMatched: face.matched,
      faceScore: face.score,
      // How crowded the frame was. Sixteen "several faces" refusals in one
      // week on the live instance were bystanders behind the counter; the
      // counts say whether a doubted mark had company or a bad photo.
      faceCount: faces?.faceCount ?? null,
      bystanders: faces?.bystanders ?? null,
    },
    ipAddress: input.ipAddress ?? null,
  });

  if (face.flagForReview) {
    /**
     * The owner is on this list because the owner is often the only person on
     * it. Every other organisation-level notification in the product names
     * `ORG_OWNER`; these three did not, and on the live instance -- where the
     * organisations have an owner, employees and a kiosk and nobody in between
     * -- a flagged check-out sat in the review queue for two days with nobody
     * told it was there.
     */
    await notify.toOrgRoles(ctx.organizationId, ["ORG_OWNER", "ADMIN", "HR_MANAGER"], {
      type: "attendance.face_flagged",
      title: "Attendance photo needs review",
      body: `${employee.firstName}'s ${input.type === "CHECK_IN" ? "check-in" : "check-out"} photo could not be verified.`,
      // The queue this notification has always implied, and which until now did
      // not exist — it linked to the attendance grid, where there was nothing
      // to act on.
      link: "/attendance/review",
    });
  }

  return {
    eventId: result.eventId,
    date: local.date,
    type: input.type,
    occurredAt: now,
    status: result.status,
    workedMinutes: result.workedMinutes,
    lateMinutes: result.lateMinutes,
    distanceMeters,
    face: {
      checked: rules.faceMatch.mode !== "OFF",
      matched: face.matched,
      confidence: confidenceOf(face.score, rules.faceMatch.threshold),
      message: face.message,
      flagged: face.flagForReview,
      reasons: face.reasons,
    },
    warnings,
  };
}

interface PendingMark {
  eventId: string;
  dayId: string;
  date: DateOnly;
  type: "CHECK_IN" | "CHECK_OUT";
  occurredAt: Date;
  status: AttendanceStatus;
  workedMinutes: number;
  lateMinutes: number;
}

/**
 * A mark of this kind, on this day, still waiting for somebody to confirm it.
 *
 * `reviewedAt: null` is the whole condition that makes this a retry rather than
 * a second punch: once an administrator has answered, the mark is settled and a
 * new photo is not a correction to it.
 */
async function findPendingMark(
  ctx: AuthContext,
  employeeId: string,
  date: DateOnly,
  type: "CHECK_IN" | "CHECK_OUT",
): Promise<PendingMark | null> {
  const event = await prisma.attendanceEvent.findFirst({
    where: {
      organizationId: ctx.organizationId!,
      employeeId,
      type,
      flaggedForReview: true,
      reviewedAt: null,
      attendanceDay: { date: new Date(`${date}T00:00:00.000Z`) },
    },
    orderBy: { occurredAt: "desc" },
    select: {
      id: true,
      occurredAt: true,
      attendanceDay: {
        select: { id: true, status: true, workedMinutes: true, lateMinutes: true },
      },
    },
  });
  if (!event?.attendanceDay) return null;

  return {
    eventId: event.id,
    dayId: event.attendanceDay.id,
    date,
    type,
    occurredAt: event.occurredAt,
    status: event.attendanceDay.status,
    workedMinutes: event.attendanceDay.workedMinutes,
    lateMinutes: event.attendanceDay.lateMinutes,
  };
}

/**
 * Another photo against a mark that is already on the record.
 *
 * The day is deliberately untouched -- no new punch, no shifted time, no second
 * event. What changes is the evidence attached to the mark that exists: a
 * better selfie, a real score, and, when it matches, the doubt lifted.
 *
 * Lifting it here rather than making an administrator do it is the point. The
 * queue exists for marks nobody could verify; a mark the employee has just
 * verified themselves, in front of the same camera, against the same enrolled
 * photo, is not one of those.
 */
async function reverifyMark(
  ctx: AuthContext,
  pending: PendingMark,
  input: {
    face: FaceMatchVerdict;
    selfieKey: string | null;
    distanceMeters: number | null;
    threshold: number;
    checked: boolean;
    warnings: string[];
  },
): Promise<MarkAttendanceResult> {
  const { face } = input;
  const cleared = face.outcome === "ACCEPTED";

  await prisma.attendanceEvent.update({
    where: { id: pending.eventId },
    data: {
      // The newest photo is the one worth keeping: it is the one an
      // administrator would be shown, and the one the employee just took.
      ...(input.selfieKey ? { selfieKey: input.selfieKey } : {}),
      faceMatchScore: face.score,
      faceMatchPassed: face.matched,
      faceMatchReason: face.reason ?? null,
      flaggedForReview: !cleared,
      ...(cleared
        ? {
            reviewedAt: new Date(),
            reviewedById: ctx.userId,
            reviewNote: "Verified by a later photo from the employee",
          }
        : {}),
    },
  });

  await writeAudit(ctx, {
    action: "attendance.marked",
    entityType: "AttendanceEvent",
    entityId: pending.eventId,
    metadata: {
      reverified: true,
      cleared,
      reason: face.reason ?? null,
      score: face.score,
    },
  });

  return {
    eventId: pending.eventId,
    date: pending.date,
    type: pending.type,
    occurredAt: pending.occurredAt,
    status: pending.status,
    workedMinutes: pending.workedMinutes,
    lateMinutes: pending.lateMinutes,
    distanceMeters: input.distanceMeters,
    face: {
      checked: input.checked,
      matched: face.matched,
      confidence: confidenceOf(face.score, input.threshold),
      message: cleared
        ? "Thank you. Your attendance is confirmed."
        : (face.message ??
          "That photo still could not be matched. An administrator will confirm it."),
      flagged: !cleared,
      reasons: face.reasons,
    },
    reverified: cleared ? "cleared" : "pending",
    warnings: input.warnings,
  };
}

/**
 * Records a refused attempt.
 *
 * A rejection that leaves no trace is worse than useless — repeated failures are
 * exactly the signal an admin needs, whether it means a broken enrolment or
 * somebody trying it on.
 */
async function recordRejectedAttempt(
  ctx: AuthContext,
  employeeId: string,
  input: MarkAttendanceInput,
  selfieKey: string | null,
  face: FaceMatchVerdict,
  fence: {
    distanceMeters: number | null;
    passed: boolean;
    faces: { faceCount: number; bystanders: number } | null;
  },
): Promise<void> {
  await prisma.attendanceEvent.create({
    data: {
      organizationId: ctx.organizationId!,
      employeeId,
      type: input.type,
      occurredAt: new Date(),
      latitude: coarsen(input.coordinates?.latitude),
      longitude: coarsen(input.coordinates?.longitude),
      accuracyMeters: wholeMetres(input.coordinates?.accuracyMeters),
      distanceMeters: fence.distanceMeters,
      withinGeofence: fence.passed,
      selfieKey,
      faceMatchScore: face.score,
      faceMatchPassed: false,
      faceMatchReason: face.reason ?? "NO_MATCH",
      flaggedForReview: true,
      // No attendanceDayId: a refused attempt must not create or alter a day.
      source: "SELF_GPS",
      note: "Refused: face verification failed",
      ipAddress: input.ipAddress ?? null,
    },
  });

  await writeAudit(ctx, {
    action: "attendance.marked",
    entityType: "AttendanceEvent",
    metadata: {
      refused: true,
      reason: face.reason,
      score: face.score,
      faceCount: fence.faces?.faceCount ?? null,
      bystanders: fence.faces?.bystanders ?? null,
    },
    ipAddress: input.ipAddress ?? null,
  });

  await notify.toOrgRoles(ctx.organizationId!, ["ORG_OWNER", "ADMIN", "HR_MANAGER"], {
    type: "attendance.face_rejected",
    title: "Attendance refused by face verification",
    body: "Someone's attendance photo did not match their reference. Review it in the attendance queue.",
    // The queue, not the grid. This said `/attendance` while the sibling
    // notification twenty lines up said `/attendance/review`, so half the
    // notifications about the review queue did not open it.
    link: "/attendance/review",
  });
}

function confidenceOf(score: number | null, threshold: number): "STRONG" | "GOOD" | "WEAK" | "NONE" {
  if (score == null) return "NONE";
  if (score >= threshold + 0.2) return "STRONG";
  if (score >= threshold) return "GOOD";
  return "WEAK";
}

/**
 * "18:30" as a person says it out loud.
 *
 * The domain returns a 24-hour string because that is what it stores and what
 * the settings form edits; a refusal read by somebody standing at a gate should
 * still say "6:30 pm".
 */
function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour = h ?? 0;
  const suffix = hour >= 12 ? "pm" : "am";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(m ?? 0).padStart(2, "0")} ${suffix}`;
}

function formatLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIME_ZONE,
  }).format(date);
}

/** What the check-in screen needs to render before anyone presses anything. */
export async function getTodayStatus(ctx: AuthContext) {
  requireOrg(ctx);
  // Matched to `markAttendance` deliberately. This used to check only that the
  // caller had an organisation, so a role without `attendance.mark.self`, or an
  // organisation with the attendance module switched off, still got a shift, a
  // work location and a day's history back from it.
  requirePermission(ctx, "attendance.mark.self");
  requireModule(ctx, "attendance");
  if (!ctx.employeeId) throw new ForbiddenError("Your login is not linked to an employee record.");

  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const wallClock = instantInZone(new Date(), timezone);
  // Rules first, because the day this screen is about depends on them: at
  // 06:00 on a 22:00-06:00 shift "today" is last night's row, and the panel
  // used to show it blank with a Check in button while the server refused
  // the check-out.
  const rules = await getAttendanceRules(ctx, wallClock.date);
  const local = shiftDayFor(rules, wallClock);
  const dayStart = new Date(`${local.date}T00:00:00.000Z`);

  const [day, employee, enrolment, pendingCheckIn, pendingCheckOut] = await Promise.all([
    prisma.attendanceDay.findUnique({
      where: { employeeId_date: { employeeId: ctx.employeeId, date: dayStart } },
      include: { events: { orderBy: { occurredAt: "asc" } } },
    }),
    prisma.employee.findUnique({
      where: { id: ctx.employeeId },
      select: {
        faceEnrolledAt: true,
        allowSelfMarking: true,
        workLocation: {
          // `active` was not selected, so the panel drew a fence, printed a
          // distance and enabled the button for a branch `markAttendance`
          // refuses to measure against at all.
          select: {
            name: true,
            active: true,
            latitude: true,
            longitude: true,
            radiusMeters: true,
            requireGps: true,
            requireSelfie: true,
          },
        },
      },
    }),
    prisma.employee.findUnique({
      where: { id: ctx.employeeId },
      select: { faceEnrolledAt: true },
    }),
    // Today's flagged, unreviewed mark of each kind, so the panel can offer
    // "Retake photo" for a doubted check-in as well as a doubted check-out.
    // A CHECK_IN with a pending CHECK_IN reaches `reverifyMark` before
    // `recordAttendance` would refuse it as a second arrival, and the
    // five-minute guard only ever runs for a CHECK_OUT.
    findPendingMark(ctx, ctx.employeeId, local.date, "CHECK_IN"),
    findPendingMark(ctx, ctx.employeeId, local.date, "CHECK_OUT"),
  ]);

  // A branch that has been switched off is not a branch. `markAttendance`
  // requires `active`, so treating it as one here would draw a fence the server
  // ignores.
  const branch = employee?.workLocation?.active ? employee.workLocation : null;

  // `null` is "no ceiling": the panel measures the distance and nothing else.
  // It used to be a constant of the fence here, and the panel refused a
  // reading the server would then have refused too -- so an old phone at the
  // counter never sent a mark at all, and the record showed a blank.
  const maxAccuracyMeters: number | null = accuracyCeiling(rules);

  // The check-in first: a doubted arrival is the one worth retaking, and a
  // day with both flagged is a day whose check-in decides everything.
  const pendingReview: "CHECK_IN" | "CHECK_OUT" | null = pendingCheckIn
    ? "CHECK_IN"
    : pendingCheckOut
      ? "CHECK_OUT"
      : null;

  return {
    // The shift day, which at 06:00 on a night shift is yesterday's date.
    date: local.date,
    // On the shift day's axis: 06:00 the morning after is minute 1800.
    nowMinutes: local.minutes,
    checkedInAt: day?.firstCheckInAt ?? null,
    checkedOutAt: day?.lastCheckOutAt ?? null,
    status: day?.status ?? "NOT_MARKED",
    pendingReview,
    workedMinutes: day?.workedMinutes ?? 0,
    lateMinutes: day?.lateMinutes ?? 0,
    shift: rules.shift,
    // `||`, not `??`, and the same composition `markAttendance` uses.
    //
    // A branch may *tighten* the organisation's rule and never loosen it. With
    // `??` a location that switched GPS off overrode an organisation policy
    // that required it — a security setting overridden by a row an office
    // manager can edit — and, worse, the two sides then disagreed about whether
    // GPS was needed at all, so the panel could offer a button the server would
    // refuse.
    requireGps: (branch?.requireGps ?? false) || rules.requireGps,
    requireSelfie: (branch?.requireSelfie ?? false) || rules.requireSelfie,
    // The panel decides with the same ceiling the server decides with, rather
    // than a constant of its own.
    maxAccuracyMeters,
    markingWindow: describeMarkingWindow(rules),
    // Nothing to measure against. Said out loud because the alternative — a
    // button that works and a fence that is never checked — is what let
    // attendance be marked from anywhere.
    noWorkLocation: branch === null,
    faceMatchMode: rules.faceMatch.mode,
    faceEnrolled: enrolment?.faceEnrolledAt != null,
    // So the panel can say why there is no button, rather than showing one that
    // will 403. The refusal itself lives in `markAttendance`; this is only the
    // explanation.
    canMarkHere: mayMarkFromOwnDevice(rules, employee ?? {}),
    kioskAvailable: rules.marking.kiosk,
    location: branch
      ? {
          name: branch.name,
          latitude: Number(branch.latitude),
          longitude: Number(branch.longitude),
          radiusMeters: branch.radiusMeters,
        }
      : null,
    events: (day?.events ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      occurredAt: e.occurredAt,
      distanceMeters: e.distanceMeters,
      // Shown beside the distance, so a rough reading is visible rather than
      // refused.
      accuracyMeters: e.accuracyMeters,
      faceMatchPassed: e.faceMatchPassed,
    })),
  };
}
