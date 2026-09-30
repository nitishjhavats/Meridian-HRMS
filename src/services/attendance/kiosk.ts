import { createHash, randomInt } from "node:crypto";
import type { EmploymentState } from "@prisma/client";
import type { AttendanceStatus } from "@/domain/attendance/policy";
import { type DateOnly, MONTH_NAMES, eachDay, endOfMonth, startOfMonth, todayInZone } from "@/domain/date";
import {
  MONTHS_BACK,
  type MonthTotals,
  countDay,
  emptyMonthTotals,
  shiftMonth,
  withinWindow,
  workingDays,
} from "@/domain/attendance/monthTotals";
import { prisma } from "@/lib/db/prisma";
import { mayIssuePin } from "./pinAuthority";
import type { AuthContext } from "@/lib/auth/context";
import {
  hasPermission,
  requireOrg,
  requirePermission,
  requireWritable,
  teamEmployeeIds,
} from "@/lib/auth/guard";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { enforce } from "@/lib/ratelimit";
import { verifyPassword } from "@/lib/auth/password";
import { effectivePermissions } from "@/lib/auth/permissions";
import { instantInZone } from "@/domain/date";
import {
  describeMarkingWindow,
  isWithinMarkingWindow,
  shiftDayFor,
} from "@/domain/attendance/policy";
import {
  DEFAULT_FACE_MATCH_POLICY,
  evaluateFaceMatch,
} from "@/domain/attendance/faceMatch";
import { MAX_SEQUENCE_FRAMES, faceEngine } from "@/lib/face/engine";
import { loadEnrolledDescriptors } from "@/services/employees/faceEnrolment";
import { compressImage, COMPRESSION } from "@/lib/storage/compress";
import { buildKey, IMAGE_CONSTRAINTS, storage, validateUpload } from "@/lib/storage";
import { getAttendanceRules } from "@/services/policy";
import { assertCheckoutNotTooSoon, facesSeen, recordAttendance } from "./record";

/**
 * Employment states a reception device does not act for.
 *
 * Written out three times in this file, and the copies had drifted -- which is
 * how the Calendar button came to be drawn on cards the month route then
 * refused. One list, one predicate, so a person shown on the roster is a person
 * every route on this screen will answer for.
 */
const OFF_ROSTER: EmploymentState[] = ["RESIGNED", "TERMINATED", "INACTIVE"];

/**
 * Who this device may show and act for.
 *
 * One predicate, used by the roster, the calendar and the mark. They have to
 * agree exactly: the last time they did not, a device drew a Calendar button on
 * every card and answered "That person" for anybody registered at another
 * branch, which reads as a broken feature rather than as a refusal.
 *
 * `branch` narrows it to the device's own work location. That is a real
 * boundary and not a display filter -- a device set to one branch will not mark
 * somebody from another, which is the point of setting it. Employees with no
 * work location at all match neither branch, so they appear on an ORGANISATION
 * device and on no WORK_LOCATION one; the create form says so, by count.
 */
function rosterScope(organizationId: string, branch?: string | null) {
  return {
    organizationId,
    active: true,
    employmentState: { notIn: OFF_ROSTER },
    ...(branch ? { workLocationId: branch } : {}),
  };
}

/**
 * The branch this device is limited to, or `null` for the whole organisation.
 *
 * Its own small query rather than a call to `getKioskContext`, deliberately.
 * That function writes `lastSeenAt` on every call and throws when the bound
 * location has been switched off; the roster is polled continuously, so
 * borrowing it would turn every poll into a write and turn one deactivated
 * location into a 403 where there used to be a list.
 */
async function deviceBranch(ctx: AuthContext): Promise<string | null> {
  const device = await prisma.kioskDevice.findFirst({
    where: { userId: ctx.userId!, organizationId: ctx.organizationId!, revokedAt: null },
    select: { rosterScope: true, workLocationId: true },
  });
  if (!device) return null;
  return device.rosterScope === "WORK_LOCATION" ? device.workLocationId : null;
}

/**
 * The shared office device.
 *
 * One account, signed in once, left on a screen in a reception. Somebody walks
 * up, taps their own name, and their face is checked against the reference photo
 * on their profile.
 *
 * Everything here follows from one fact: **this is the only place in the product
 * where an account acts for a different person.** Elsewhere the session is the
 * proof of identity. Here the session only proves which building the screen is
 * in, and the face is the proof of who is standing at it. So:
 *
 *   - face matching is forced to REQUIRED whatever the organisation has set,
 *     because the org default is ADVISORY and in ADVISORY a mismatch is allowed
 *     — right on a personal phone, catastrophic on a screen anyone can walk up
 *     to;
 *   - the two ways past a failed match are single-use and short-lived, and both
 *     land in the review queue;
 *   - every lookup is scoped to the kiosk's own organisation explicitly, never
 *     through the scope helpers, which answer a different question.
 */

/** How long an issued PIN is good for. Long enough to walk to the device. */
const PIN_MINUTES = 15;

export interface KioskContext {
  deviceId: string;
  label: string;
  organizationName: string;
  workLocation: {
    id: string;
    name: string;
    latitude: number;
    longitude: number;
    /**
     * Where the device physically stands, in two lines.
     *
     * A reception screen that cannot say which building it is in is no use to
     * somebody standing in front of it wondering whether they are at the right
     * one. This selected the name and the coordinates and nothing else.
     */
    addressLines: string[];
  };
  /**
   * Whether this screen lists the whole organisation or only its own branch.
   *
   * On the screen, because somebody standing at a device looking for a
   * colleague who is not there deserves to be told why rather than left to
   * conclude the product is broken.
   */
  rosterScope: "ORGANISATION" | "WORK_LOCATION";
}

/**
 * Which device this is, and where it stands.
 *
 * The bound work location is not decoration: a reception desktop has no GPS, so
 * this is where the coordinates on every mark come from. A device whose location
 * has been deactivated stops working rather than silently recording marks with
 * no place attached.
 */
export async function getKioskContext(ctx: AuthContext): Promise<KioskContext> {
  requireOrg(ctx);
  requirePermission(ctx, "attendance.kiosk.operate");

  const device = await prisma.kioskDevice.findFirst({
    where: { userId: ctx.userId, organizationId: ctx.organizationId, revokedAt: null },
    select: {
      id: true,
      label: true,
      rosterScope: true,
      organization: { select: { name: true } },
      workLocation: {
        select: {
          id: true,
          name: true,
          latitude: true,
          longitude: true,
          active: true,
          address: true,
          addressLine2: true,
        },
      },
    },
  });

  if (!device) throw new NotFoundError("This device");
  if (!device.workLocation.active) {
    throw new ForbiddenError(
      "The work location this device belongs to has been switched off. An administrator needs to point it somewhere else.",
    );
  }

  // Cheap and useful: an admin looking at the device list can tell which screens
  // are actually still switched on.
  void prisma.kioskDevice
    .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);

  return {
    deviceId: device.id,
    label: device.label,
    rosterScope: device.rosterScope,
    organizationName: device.organization.name,
    workLocation: {
      id: device.workLocation.id,
      name: device.workLocation.name,
      latitude: Number(device.workLocation.latitude),
      longitude: Number(device.workLocation.longitude),
      // Blank lines dropped here rather than in the component, so the screen
      // renders what it is given and never a stray separator.
      addressLines: [device.workLocation.address, device.workLocation.addressLine2]
        .map((line) => line?.trim())
        .filter((line): line is string => Boolean(line)),
    },
  };
}

export interface RosterEntry {
  id: string;
  name: string;
  employeeCode: string;
  photoUrl: string | null;
  department: string | null;
  workLocation: string | null;
  faceEnrolled: boolean;
  checkedInAt: string | null;
  checkedOutAt: string | null;
}

/**
 * Everybody the device may mark.
 *
 * The whole organisation, as asked for — a visitor from another branch should be
 * able to mark at the reception they are standing in. Their own location is
 * shown on the card so the difference is visible rather than hidden.
 *
 * `faceEnrolled` is on every card because the alternative is somebody queueing,
 * tapping their name, and only then learning there is no photo to check against.
 */
export async function getKioskRoster(ctx: AuthContext): Promise<RosterEntry[]> {
  requireOrg(ctx);
  requirePermission(ctx, "attendance.kiosk.operate");

  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const wallClock = instantInZone(new Date(), timezone);
  // The same shift day `markAtKiosk` writes to, so at 06:00 on a night shift
  // the cards show last night's check-in rather than a blank.
  const today = shiftDayFor(await getAttendanceRules(ctx, wallClock.date), wallClock).date;
  const dayStart = new Date(`${today}T00:00:00.000Z`);

  const branch = await deviceBranch(ctx);

  const employees = await prisma.employee.findMany({
    where: rosterScope(ctx.organizationId!, branch),
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      photoKey: true,
      faceEnrolledAt: true,
      department: { select: { name: true } },
      workLocation: { select: { name: true } },
      attendanceDays: {
        where: { date: dayStart },
        select: { firstCheckInAt: true, lastCheckOutAt: true },
        take: 1,
      },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
  });

  return employees.map((e) => {
    const day = e.attendanceDays[0];
    return {
      id: e.id,
      name: [e.firstName, e.lastName].filter(Boolean).join(" "),
      employeeCode: e.employeeCode,
      photoUrl: e.photoKey ? `/api/files/${e.photoKey}` : null,
      department: e.department?.name ?? null,
      workLocation: e.workLocation?.name ?? null,
      faceEnrolled: e.faceEnrolledAt != null,
      checkedInAt: day?.firstCheckInAt?.toISOString() ?? null,
      checkedOutAt: day?.lastCheckOutAt?.toISOString() ?? null,
    };
  });
}

export type KioskBypassInput =
  | { kind: "PIN"; code: string }
  | { kind: "SUPERVISOR"; email: string; password: string; reason: string };

export interface KioskMarkInput {
  employeeId: string;
  type: "CHECK_IN" | "CHECK_OUT";
  selfie?: { data: Buffer; fileName: string; mimeType: string } | null;
  /**
   * The rest of the burst the selfie came from, in capture order.
   *
   * Read for the blink check and then discarded -- only `selfie` is stored.
   * This screen forces REQUIRED matching, so it was the one place a printed
   * photo defeated every check there was.
   */
  frames?: { data: Buffer; fileName: string; mimeType: string }[] | null;
  bypass?: KioskBypassInput | null;
  /**
   * "I have tried enough times." The device asks for this after the refusals a
   * reason is worth; the mark is taken and always flagged for review.
   */
  acceptForReview?: boolean;
  deviceInfo?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export interface KioskMarkResult {
  name: string;
  type: "CHECK_IN" | "CHECK_OUT";
  status: string;
  lateMinutes: number;
  bypassed: boolean;
  message?: string;
}

export async function markAtKiosk(
  ctx: AuthContext,
  input: KioskMarkInput,
): Promise<KioskMarkResult> {
  requireOrg(ctx);
  requirePermission(ctx, "attendance.mark.kiosk");
  requireWritable(ctx);

  const device = await getKioskContext(ctx);

  /**
   * Scoped to the kiosk's own organisation, explicitly. Never through
   * `visibleEmployeeIds`, which answers "how much may this role see" and
   * returns "no restriction" for a wide scope — a scope filter is not a
   * tenancy boundary.
   *
   * And scoped to the device's branch when it has one. A device narrowed to a
   * work location must refuse a mark for somebody at another, or the setting is
   * a tidier list and nothing else: the roster is the only way to reach this
   * route through the screen, but a route is reachable without a screen.
   */
  const branch = device.rosterScope === "WORK_LOCATION" ? device.workLocation.id : null;
  const employee = await prisma.employee.findFirst({
    where: {
      id: input.employeeId,
      organizationId: ctx.organizationId,
      ...(branch ? { workLocationId: branch } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      active: true,
      employmentState: true,
      departmentId: true,
      faceEnrolledAt: true,
      weeklyOffPattern: { select: { config: true } },
      // The person's own rest days sit above the pattern; carried here so the
      // resolver does not have to go back for them inside the transaction.
      weeklyOffConfig: true,
      trainingPlans: { select: { startDate: true, endDate: true } },
    },
  });
  if (!employee) throw new NotFoundError("That employee");

  if (!employee.active || OFF_ROSTER.includes(employee.employmentState)) {
    throw new ForbiddenError(
      `${employee.firstName}'s employment record is not active, so attendance cannot be marked.`,
    );
  }

  await enforce("attendanceMark", `kiosk:${employee.id}`);

  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const now = new Date();
  const wallClock = instantInZone(now, timezone);
  const rules = await getAttendanceRules(ctx, wallClock.date);
  // The shift day, not the calendar date: a 22:00-06:00 shift's 06:00
  // check-out fell on the next date, found no check-in there, and reception
  // was told "has not checked in today" -- every night. Same resolution as
  // the phone, so the two paths key the same row.
  const local = shiftDayFor(rules, wallClock);

  if (!rules.marking.kiosk) {
    throw new ForbiddenError(
      "This organisation does not record attendance on a shared device. An administrator can switch it on in the attendance settings.",
    );
  }

  // The same window the phone path enforces.
  //
  // The office device had none at all, which made the phone's window
  // decorative: anybody refused at 5 a.m. on their own phone could walk to
  // reception and mark there. Checked here, before the selfie is uploaded, so a
  // refusal does not leave a stored object behind.
  if (!isWithinMarkingWindow(rules, local.minutes)) {
    const window = describeMarkingWindow(rules);
    throw new ValidationError(
      `Attendance can only be marked between ${window.opens} and ${window.closes}. Ask an administrator to record it.`,
    );
  }

  // A check-out seconds after the check-in is the button pressed twice, not
  // a departure. Refused here, before a PIN is spent or a selfie is stored --
  // both would be gone by the time `recordAttendance` refused it inside the
  // transaction, and a spent PIN is a walk back to whoever issued it.
  if (input.type === "CHECK_OUT") {
    const today = await prisma.attendanceDay.findUnique({
      where: { employeeId_date: { employeeId: employee.id, date: new Date(`${local.date}T00:00:00.000Z`) } },
      select: { firstCheckInAt: true },
    });
    assertCheckoutNotTooSoon(today, now, "other", employee.firstName);
  }

  let selfieKey: string | null = null;
  let faceScore: number | null = null;
  let facePassed: boolean | null = null;
  let faceReason: string | null = null;
  let flagged = false;
  let bypassKind: "PIN" | "SUPERVISOR" | null = null;
  let bypassById: string | null = null;
  let message: string | undefined;
  // What the detector saw, for the audit row. Null on a bypass: no photo.
  let faces: { faceCount: number; bystanders: number } | null = null;

  if (input.bypass) {
    const authorised = await authoriseBypass(ctx, employee.id, input.bypass);
    bypassKind = input.bypass.kind;
    bypassById = authorised.byUserId;
    facePassed = false;
    faceReason = input.bypass.kind;
    // Always flagged. A mark that skipped the only identity check this device
    // has must be visible to somebody afterwards.
    flagged = true;
    message = authorised.message;
  } else {
    if (!input.selfie) {
      throw new ValidationError("A photo is needed to mark attendance on this device.");
    }

    validateUpload(input.selfie.data, input.selfie.mimeType, input.selfie.fileName, IMAGE_CONSTRAINTS);
    const compressed = await compressImage(input.selfie.data, COMPRESSION.selfie);
    selfieKey = buildKey(ctx.organizationId!, "selfies", compressed.extension);

    const [candidate, references] = await Promise.all([
      faceEngine().describeSequence(
        (input.frames?.length ? input.frames : [input.selfie])
          .slice(0, MAX_SEQUENCE_FRAMES)
          .map((frame) => {
            // Each frame is an upload like any other, and is checked like one.
            validateUpload(frame.data, frame.mimeType, frame.fileName, IMAGE_CONSTRAINTS);
            return frame.data;
          }),
      ),
      loadEnrolledDescriptors(employee.id),
    ]);
    faces = facesSeen(candidate);

    // The load-bearing line. Whatever the organisation has chosen, a shared
    // screen enforces: on a personal phone the login already proves who you are,
    // and here it proves nothing but which room the device is in.
    const verdict = evaluateFaceMatch(candidate, references, {
      ...rules.faceMatch,
      mode: "REQUIRED",
      whenNotEnrolled: "BLOCK",
      // Everything, not two fields.
      //
      // It hardened `mode` and `whenNotEnrolled` and then inherited
      // `requireBlink`, `threshold` and `rejectMultipleFaces` from the
      // organisation -- so an admin who switched the blink off on the settings
      // screen switched it off on the shared device too, and a printed photo
      // held up at reception passed. A device on a wall is the one place none of
      // this may be softened, which is what the comment above already said.
      requireBlink: true,
      rejectMultipleFaces: true,
      threshold: Math.max(rules.faceMatch.threshold, DEFAULT_FACE_MATCH_POLICY.threshold),
      /**
       * Named, not inherited, and the value is the owner's answer.
       *
       * Every other field on this list is hardened. This one is deliberately
       * *not*: a reception queue at nine in the morning is a worse failure than
       * a mark an administrator has to look at, and rejecting one now actually
       * removes the day. It is named here rather than left to the spread for
       * the reason the comment above gives -- the last field this device
       * inherited by accident let a printed photo through.
       */
      onMismatch: "REVIEW",
      /**
       * Inherited on purpose, and named so the inheritance is a decision.
       *
       * How many times a reception queue watches somebody be turned away is the
       * same question on the wall as on the phone, and the owner answers it once
       * on the settings screen. Hardening it here would give the shared device a
       * different door from the one the settings describe.
       */
      retriesBeforeReview: rules.faceMatch.retriesBeforeReview,
    });

    // Stored either way — a refused photo is the evidence of the refusal.
    await storage().put(selfieKey, compressed.data, compressed.mimeType, {
      organizationId: ctx.organizationId!,
      kind: "selfies",
    });

    faceScore = verdict.score;
    facePassed = verdict.matched;
    faceReason = verdict.reason ?? null;
    flagged = verdict.flagForReview;

    /**
     * "face match na ho to retry ka option de fir lag k review me chala jaaye."
     *
     * The device counts its own attempts and asks for this once the policy's
     * `retriesBeforeReview` are spent, which is the same contract the phone has. It is honoured only where the policy
     * leaves a way out at all, so an organisation that sets `onMismatch:
     * "BLOCK"` keeps a closed door at reception too.
     */
    if (!verdict.allowed && input.acceptForReview && verdict.reviewAfterAttempts !== null) {
      facePassed = verdict.matched;
      faceScore = verdict.score;
      faceReason = verdict.reason ?? null;
      flagged = true;
    } else if (!verdict.allowed) {
      await recordKioskRefusal(ctx, employee, device, selfieKey, verdict.reason ?? "NO_MATCH", input);
      // The reason travels with the refusal, exactly as it does on the phone.
      // Without it the reception screen could only print one sentence in one
      // alert, so a face that would not match and a face nobody had enrolled
      // looked the same to the person standing there — and neither of them
      // pointed at the PIN that would have got them through the door.
      throw new ValidationError(
        verdict.reason === "NOT_ENROLLED"
          ? `${employee.firstName} has no reference photo yet, so this device cannot verify them. Ask HR to add one, or use a one-time PIN.`
          : (verdict.message ?? "That photo could not be verified."),
        {
          face: verdict.reason ?? "NO_MATCH",
          reviewAfterAttempts: verdict.reviewAfterAttempts,
        },
      );
    }
  }

  const result = await prisma.$transaction((tx) =>
    recordAttendance(tx, ctx, {
      employee,
      type: input.type,
      now,
      timezone,
      local,
      rules,
      subject: "other",
      facts: {
        // The device is the fence. A reception desktop has no GPS, so the bound
        // work location supplies the position rather than the browser.
        latitude: device.workLocation.latitude,
        longitude: device.workLocation.longitude,
        accuracyMeters: null,
        distanceMeters: 0,
        withinGeofence: true,
        workLocationId: device.workLocation.id,
        selfieKey,
        faceMatchScore: faceScore,
        faceMatchPassed: facePassed,
        faceMatchReason: faceReason,
        flaggedForReview: flagged,
        deviceInfo: { ...(input.deviceInfo ?? {}), kiosk: device.label },
        ipAddress: input.ipAddress ?? null,
        source: "KIOSK",
        kioskBypass: bypassKind,
        bypassById,
        note: bypassKind ? `Marked on ${device.label} without a face match (${bypassKind})` : null,
      },
    }),
  );

  await writeAudit(ctx, {
    action: "attendance.kiosk.marked",
    entityType: "AttendanceEvent",
    entityId: result.eventId,
    metadata: {
      employeeId: employee.id,
      device: device.label,
      type: input.type,
      status: result.status,
      faceMatched: facePassed,
      // Reception is the crowded frame: the counts say whether a doubted
      // mark had somebody behind it or a bad photo.
      faceCount: faces?.faceCount ?? null,
      bystanders: faces?.bystanders ?? null,
      bypass: bypassKind,
      bypassById,
    },
    ipAddress: input.ipAddress ?? null,
  });

  if (flagged) {
    await notify.toOrgRoles(ctx.organizationId!, ["ORG_OWNER", "ADMIN", "HR_MANAGER"], {
      type: "attendance.face_flagged",
      title: bypassKind ? "Attendance marked without a face check" : "Attendance photo needs review",
      body: bypassKind
        ? `${employee.firstName} was marked on ${device.label} using ${bypassKind === "PIN" ? "a one-time PIN" : "a supervisor override"}.`
        : `${employee.firstName}'s photo on ${device.label} could not be verified.`,
      // The queue, not the grid. The phone's copy of this notification was
      // repointed and this one was not, so half of them opened the wrong page.
      link: "/attendance/review",
    });
  }

  return {
    name: [employee.firstName, employee.lastName].filter(Boolean).join(" "),
    type: input.type,
    status: result.status,
    lateMinutes: result.lateMinutes,
    bypassed: bypassKind !== null,
    message,
  };
}

/* -------------------------------------------------------------------------- */
/*  Getting past a face that will not match                                    */
/* -------------------------------------------------------------------------- */

async function authoriseBypass(
  ctx: AuthContext,
  employeeId: string,
  bypass: KioskBypassInput,
): Promise<{ byUserId: string; message: string }> {
  return bypass.kind === "PIN"
    ? redeemPin(ctx, employeeId, bypass.code)
    : supervisorOverride(ctx, employeeId, bypass);
}

async function redeemPin(
  ctx: AuthContext,
  employeeId: string,
  code: string,
): Promise<{ byUserId: string; message: string }> {
  // Rate limited per employee, which is what makes a six-digit secret safe:
  // guessing it online is the only avenue, and this closes it.
  await enforce("otpVerify", `kioskpin:${employeeId}`);

  const now = new Date();
  const pin = await prisma.attendancePin.findFirst({
    where: {
      organizationId: ctx.organizationId!,
      employeeId,
      codeHash: hashPin(code),
      usedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true, issuedById: true },
  });

  if (!pin) {
    // One message for wrong, expired and already-used. Distinguishing them tells
    // somebody holding a wrong code which part to keep trying.
    throw new ValidationError("That PIN is not valid. Ask for a new one.");
  }

  // Spent immediately, in its own write, so two devices racing the same code
  // cannot both win.
  const spent = await prisma.attendancePin.updateMany({
    where: { id: pin.id, usedAt: null },
    data: { usedAt: now },
  });
  if (spent.count === 0) throw new ValidationError("That PIN has already been used.");

  return { byUserId: pin.issuedById, message: "Marked using a one-time PIN." };
}

/**
 * A supervisor standing at the device, entering their own credentials.
 *
 * Every line of this is the fix for a finding from the design audit. `User`
 * carries `@@unique([organizationId, email])` — email is *not* globally unique,
 * and the login route already handles one address resolving to several
 * organisations. A lookup on email alone would authenticate the first matching
 * row in **any** tenant, and the obvious follow-up check does not save it:
 * `visibleEmployeeIds` returns "no restriction" for an `all` scope, so an ADMIN
 * of any organisation would pass an employee check for any employee id.
 *
 * The realistic attack is not espionage. It is buddy-punching: fail the face
 * match deliberately, open this modal, and enter credentials for a free trial
 * organisation you made yourself.
 */
async function supervisorOverride(
  ctx: AuthContext,
  employeeId: string,
  bypass: { email: string; password: string; reason: string },
): Promise<{ byUserId: string; message: string }> {
  const email = bypass.email.trim().toLowerCase();
  const reason = bypass.reason.trim();
  if (reason.length < 4) {
    throw new ValidationError("Give a reason — it is shown to whoever reviews this afterwards.");
  }

  await enforce("login", `kiosk-ip:${ctx.organizationId}`);
  await enforce("login", `kiosk-email:${email}`);

  // Scoped to *this* organisation. Never `findFirst` on email alone.
  const supervisor = await prisma.user.findFirst({
    where: { email, organizationId: ctx.organizationId },
    select: {
      id: true,
      role: true,
      status: true,
      lockedUntil: true,
      passwordHash: true,
      permissionGrants: { select: { permission: true, granted: true } },
      employee: { select: { id: true } },
    },
  });

  // One message for every failure below, so this endpoint is not an oracle for
  // who works here.
  const refuse = () => new ValidationError("That email or password is not right.");

  if (!supervisor) throw refuse();
  if (supervisor.status !== "ACTIVE") throw refuse();
  if (supervisor.lockedUntil && supervisor.lockedUntil > new Date()) throw refuse();
  if (!(await verifyPassword(bypass.password, supervisor.passwordHash))) throw refuse();

  // Checked against the supervisor's *own* permissions and their own place in
  // the reporting graph — never the kiosk's, which has neither.
  const theirContext: AuthContext = {
    ...ctx,
    userId: supervisor.id,
    role: supervisor.role,
    employeeId: supervisor.employee?.id ?? null,
    permissions: effectivePermissions(supervisor.role, supervisor.permissionGrants),
  };

  if (!hasPermission(theirContext, "attendance.override")) {
    // Otherwise it has to be somebody who actually reports to them. A supervisor
    // with no employee record of their own reports to nobody, so this refuses.
    const team = await teamEmployeeIds(theirContext);
    if (!team.includes(employeeId)) {
      throw new ForbiddenError(
        "You can only do this for somebody who reports to you, or with an administrator's account.",
      );
    }
  }

  return { byUserId: supervisor.id, message: `Marked by ${email} — ${reason}` };
}

/* -------------------------------------------------------------------------- */
/*  Issuing a PIN                                                              */
/* -------------------------------------------------------------------------- */

export interface IssuedPin {
  code: string;
  expiresAt: Date;
  employeeName: string;
}

/**
 * A one-shot code, read out to somebody whose face will not match today.
 *
 * Issued on demand rather than being a standing personal PIN: nothing is written
 * on a card or left on the device, and a code that lived fifteen minutes and was
 * spent once is worth nothing to whoever finds it afterwards.
 */
export async function issueAttendancePin(
  ctx: AuthContext,
  employeeId: string,
  reason?: string,
): Promise<IssuedPin> {
  requireOrg(ctx);
  requireWritable(ctx);

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId: ctx.organizationId },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!employee) throw new NotFoundError("That employee");

  /**
   * Three ways in, and an administrator can see all three.
   *
   * Somebody an administrator has named -- by designation or individually -- on
   * the PIN authority screen; anybody holding `attendance.override`; or the
   * person's own reporting manager, which is where this started and which stays
   * because a manager standing next to their own team member is the commonest
   * case of all.
   */
  /**
   * Never for yourself, whoever you are, and this was the whole face check.
   *
   * `teamEmployeeIds` seeds its set with the caller (`guard.ts:114`), so the
   * fallback below matched an ordinary employee asking for a code for
   * themselves. A PIN marks attendance with **no photo at all**: every
   * employee with a login could therefore skip the face match, the blink and
   * the geofence entirely, by design, in one request. Strict matching,
   * liveness and the kiosk's forced REQUIRED were all downstream of a door
   * that was open.
   *
   * Checked before the authority, not inside its else-branch: an administrator
   * could still issue their own until the PIN desk gave everybody a picker,
   * and issuing for yourself is the same self-approval this product already
   * refuses for leave, for attendance corrections and for your own salary.
   */
  const forSelf = ctx.employeeId != null && ctx.employeeId === employeeId;
  if (forSelf) {
    throw new ForbiddenError(
      "You cannot issue yourself an attendance PIN. Ask somebody on the PIN authority list -- the check-in screen names them.",
    );
  }

  if (!(await mayIssuePin(ctx))) {
    // A manager issuing for their own report stays: that is the commonest
    // honest case and somebody is standing there watching.
    const team = await teamEmployeeIds(ctx);
    if (!team.includes(employeeId)) {
      throw new ForbiddenError(
        "You are not allowed to issue attendance PINs. An administrator can grant that on the PIN authority screen.",
      );
    }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + PIN_MINUTES * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    // Any code still outstanding for this person is spent first, so only one is
    // ever live and an issued-but-unused code cannot be banked.
    await tx.attendancePin.updateMany({
      where: { organizationId: ctx.organizationId!, employeeId, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.attendancePin.create({
      data: {
        organizationId: ctx.organizationId!,
        employeeId,
        codeHash: hashPin(code),
        issuedById: ctx.userId,
        expiresAt,
        reason: reason?.trim() || null,
      },
    });
  });

  await writeAudit(ctx, {
    action: "attendance.kiosk.pin_issued",
    entityType: "Employee",
    entityId: employeeId,
    metadata: { expiresAt, reason: reason?.trim() || null },
  });

  return {
    code,
    expiresAt,
    employeeName: [employee.firstName, employee.lastName].filter(Boolean).join(" "),
  };
}

/* -------------------------------------------------------------------------- */

function hashPin(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

/** A refused attempt still leaves a trace; repeated ones are the signal. */
async function recordKioskRefusal(
  ctx: AuthContext,
  employee: { id: string; firstName: string },
  device: KioskContext,
  selfieKey: string,
  reason: string,
  input: KioskMarkInput,
): Promise<void> {
  await prisma.attendanceEvent.create({
    data: {
      organizationId: ctx.organizationId!,
      employeeId: employee.id,
      type: input.type,
      occurredAt: new Date(),
      workLocationId: device.workLocation.id,
      withinGeofence: true,
      selfieKey,
      faceMatchPassed: false,
      faceMatchReason: reason,
      flaggedForReview: true,
      source: "KIOSK",
      ipAddress: input.ipAddress ?? null,
      note: `Refused on ${device.label}: face verification failed`,
    },
  });

  await writeAudit(ctx, {
    action: "attendance.kiosk.marked",
    entityType: "Employee",
    entityId: employee.id,
    metadata: { refused: true, reason, device: device.label },
    ipAddress: input.ipAddress ?? null,
  });
}

/* -------------------------------------------------------------------------- */
/*  A month, at the device                                                     */
/* -------------------------------------------------------------------------- */

export interface KioskMonthDay {
  date: DateOnly;
  day: number;
  status: AttendanceStatus;
}

export interface KioskMonth {
  year: number;
  month: number;
  label: string;
  daysInMonth: number;
  workingDays: number;
  days: KioskMonthDay[];
  totals: MonthTotals;
  /** Whether the arrows have anywhere left to go. */
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * One person's month, read at the reception screen.
 *
 * Its own service rather than `getMonthlyGrid`, for one reason: that one scopes
 * through `visibleEmployeeIds(ctx, "attendance.read")`, and a device holds
 * neither that permission nor any other read permission — `KIOSK_PERMISSIONS`
 * is `attendance.kiosk.operate` and `attendance.mark.kiosk`, and nothing else.
 * Widening the role to reach the grid would give a screen bolted to a wall the
 * ability to read the whole organisation's attendance.
 *
 * The scope here is the device's own roster, which is exactly the set of people
 * it can already mark attendance for and already displays by name. Somebody not
 * on it reads as absent rather than as forbidden, because a device confirming
 * that a person exists elsewhere in the organisation is a leak of its own.
 *
 * Bounded to the last three months. A reception screen is answering "was I
 * marked absent in March", not offering a year of somebody else's record to
 * whoever is standing in front of it.
 */
export async function getKioskMonth(
  ctx: AuthContext,
  input: { employeeId: string; year: number; month: number },
): Promise<KioskMonth> {
  // Called for what it proves -- that this request came from a registered,
  // signed-in device -- and not for the branch it names. The branch is
  // deliberately not part of the scope; see below.
  await getKioskContext(ctx);

  const now = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const nowCursor = { year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) };
  const cursor = { year: input.year, month: input.month };
  if (!withinWindow(cursor, nowCursor)) {
    throw new ValidationError(
      `This screen shows the last ${MONTHS_BACK} months. Ask an administrator for anything older.`,
    );
  }

  /**
   * On this device's roster, or nothing.
   *
   * This scoped to `workLocationId = device.workLocation.id` and the roster
   * does not: `getKioskRoster` lists every active employee in the organisation,
   * because a device marks attendance for whoever walks up to it. So the screen
   * drew a Calendar button on every card and the route answered "That person"
   * for anybody registered at another branch -- which is the reported bug, and
   * why it looked like one particular person's calendar was broken. One
   * predicate, shared with the roster, or the button lies.
   */
  const onRoster = await prisma.employee.findFirst({
    where: { id: input.employeeId, ...rosterScope(ctx.organizationId!, await deviceBranch(ctx)) },
    select: { id: true },
  });
  if (!onRoster) throw new NotFoundError("That person");

  const periodStart = startOfMonth(input.year, input.month);
  const periodEnd = endOfMonth(input.year, input.month);
  const dates = eachDay(periodStart, periodEnd);

  const rows = await prisma.attendanceDay.findMany({
    where: {
      organizationId: ctx.organizationId!,
      employeeId: input.employeeId,
      date: { gte: new Date(`${periodStart}T00:00:00.000Z`), lte: new Date(`${periodEnd}T00:00:00.000Z`) },
    },
    select: { date: true, status: true, lateMinutes: true },
  });
  const byDate = new Map(rows.map((r) => [r.date.toISOString().slice(0, 10), r]));

  const totals = emptyMonthTotals();
  const days = dates.map((date, index) => {
    const record = byDate.get(date);
    const status: AttendanceStatus = record?.status ?? "NOT_MARKED";
    countDay(totals, status, record?.lateMinutes ?? 0);
    return { date, day: index + 1, status };
  });

  return {
    year: input.year,
    month: input.month,
    label: `${MONTH_NAMES[input.month - 1]} ${input.year}`,
    daysInMonth: dates.length,
    workingDays: workingDays(dates.length, totals),
    days,
    totals,
    canGoBack: withinWindow(shiftMonth(cursor, -1), nowCursor),
    canGoForward: withinWindow(shiftMonth(cursor, 1), nowCursor),
  };
}
