import { createHash } from "node:crypto";
import type { AttendanceStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { enforce } from "@/lib/ratelimit";
import { notify } from "@/lib/notify";
import type { DateOnly } from "@/domain/date";
import type { DayKind } from "@/domain/calendar";
import { dayKindFor } from "./dayKind";

/**
 * Attendance that was marked but not verified.
 *
 * On a personal phone the face check is advisory: a mismatch marks the day and
 * flags it, because bad light or an old camera should not cost somebody a day's
 * pay. That is the right trade — but until now it went nowhere. The employee saw
 * a warning string that scrolled away and nothing telling them the day was
 * unconfirmed; the administrator got a notification and had no screen to act on;
 * and `reviewFlaggedEvents` sat in the codebase with no caller at all.
 *
 * So a flagged mark now has a visible state and two ways out of it. The employee
 * can clear it themselves with a one-time PIN from their manager, on the phone,
 * in the moment. Or an administrator looks at the selfie beside the enrolled
 * photo and decides. Both are recorded; neither is a `kioskBypass`, because that
 * column answers "how many marks skipped verification" and these are the
 * opposite — marks that were verified, late.
 */

const PIN_MINUTES = 15;

function hashPin(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export interface FlaggedEvent {
  id: string;
  occurredAt: string;
  type: string;
  employee: { id: string; name: string; employeeCode: string };
  /** The photo taken at the moment of marking, if it has not aged out. */
  selfieUrl: string | null;
  selfiePurged: boolean;
  /** What they were enrolled with, to compare against. */
  referenceUrl: string | null;
  faceMatchScore: number | null;
  faceMatchReason: string | null;
  distanceMeters: number | null;
  /**
   * How rough the reading behind that distance was. The accuracy no longer
   * gates a mark, so it has to be visible where the mark is judged: 18 m at
   * ±200 m is a different fact from 18 m at ±5 m.
   */
  accuracyMeters: number | null;
  withinGeofence: boolean;
  source: string;
  note: string | null;
}

/**
 * Everything waiting to be looked at.
 *
 * Newest first: a mark from this morning can still be resolved by asking the
 * person, and one from three weeks ago cannot.
 */
export async function listFlaggedEvents(
  ctx: AuthContext,
  options: { limit?: number } = {},
): Promise<FlaggedEvent[]> {
  requireOrg(ctx);
  requirePermission(ctx, "attendance.override");

  /**
   * Only the people this reader is responsible for.
   *
   * The queue had no scope check at all: it filtered on `organizationId` and
   * nothing else, so a SUPERVISOR -- a role whose entire design point is being
   * narrow -- could list every employee's flagged mark and open every one of
   * their selfies. `overrideDay` was given exactly this check, with the comment
   * "attendance decides payable days, which is pay".
   *
   * It matters more now than it did. Rejecting from this screen removes
   * somebody's attendance, so an unscoped queue is org-wide power to erase a
   * day. `null` means no restriction, which is what every organisation-wide
   * holder gets, so this is a no-op for HR, Admin and the owner.
   */
  const visible = await visibleEmployeeIds(ctx, "attendance.read");

  const events = await prisma.attendanceEvent.findMany({
    where: {
      organizationId: ctx.organizationId!,
      ...(visible !== null ? { employeeId: { in: visible } } : {}),
      flaggedForReview: true,
      reviewedAt: null,
      // A refused attempt has no day attached and is not somebody's attendance
      // waiting to be confirmed — it is a record that somebody tried. Those
      // belong in the audit trail, not in a queue an administrator works
      // through.
      attendanceDayId: { not: null },
    },
    orderBy: { occurredAt: "desc" },
    take: Math.min(options.limit ?? 100, 200),
    select: {
      id: true,
      occurredAt: true,
      type: true,
      selfieKey: true,
      selfiePurgedAt: true,
      faceMatchScore: true,
      faceMatchReason: true,
      distanceMeters: true,
      accuracyMeters: true,
      withinGeofence: true,
      source: true,
      note: true,
      employee: {
        select: { id: true, firstName: true, lastName: true, employeeCode: true, facePhotoKey: true },
      },
    },
  });

  return events.map((event) => ({
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    type: event.type,
    employee: {
      id: event.employee.id,
      name: [event.employee.firstName, event.employee.lastName].filter(Boolean).join(" "),
      employeeCode: event.employee.employeeCode,
    },
    // Through the authenticated file route, which checks the tenant prefix.
    selfieUrl: event.selfieKey ? `/api/files/${event.selfieKey}` : null,
    selfiePurged: event.selfiePurgedAt !== null,
    referenceUrl: event.employee.facePhotoKey
      ? `/api/files/${event.employee.facePhotoKey}`
      : null,
    faceMatchScore: event.faceMatchScore ? Number(event.faceMatchScore) : null,
    faceMatchReason: event.faceMatchReason,
    distanceMeters: event.distanceMeters,
    accuracyMeters: event.accuracyMeters,
    withinGeofence: event.withinGeofence,
    source: event.source,
    note: event.note,
  }));
}

/**
 * An administrator's decision on one flagged mark.
 *
 * **Rejecting now removes the mark.** It used to be an annotation: the note
 * said so, and the reasoning was that a queue which silently removed attendance
 * would be a queue nobody could audit. Sound, and it produced the wrong screen.
 * The verdict cleared the row from the queue *and* from the grid's flag while
 * leaving `status` untouched, so an administrator who rejected a mark and then
 * forgot the second step at the grid left a full paid day with no warning
 * anywhere except the employee's own phone. Rejecting something and having it
 * still be there is not a verdict.
 *
 * What it does not do is delete a row. The punches are cleared, the counters
 * are zeroed, the day falls back to what it would have been, and the
 * `AttendanceEvent` stays exactly where it is with the selfie, the score, the
 * reason and the name of whoever rejected it. Nothing an organisation has
 * already exported disappears, and the audit trail reads forwards.
 *
 * It refuses on a payroll that has been locked or paid. A payslip somebody has
 * banked must not change because of a click on this screen.
 */
export async function reviewEvent(
  ctx: AuthContext,
  eventId: string,
  input: { verdict: "VERIFIED" | "REJECTED"; note?: string },
): Promise<{ id: string; verdict: string }> {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.override", "attendance");

  /**
   * The same scope the queue lists by, applied to the act rather than the list.
   *
   * Listing is filtered; deciding is by id, and an id can be typed. Without
   * this a supervisor could reject any employee's mark in the organisation by
   * calling the route directly, which is now the power to erase a day.
   */
  const visible = await visibleEmployeeIds(ctx, "attendance.read");

  const event = await prisma.attendanceEvent.findFirst({
    where: { id: eventId, organizationId: ctx.organizationId! },
    select: {
      id: true,
      employeeId: true,
      type: true,
      occurredAt: true,
      reviewedAt: true,
      attendanceDayId: true,
      // The day the punch was written to. It is the key payroll and the grid
      // read the day by, so it -- not the calendar date of `occurredAt` -- is
      // the date whose kind decides what a rejected check-in leaves behind. A
      // night shift's 06:00 check-out sits on the previous date's row, and
      // the row already says so.
      attendanceDay: { select: { date: true } },
      employee: {
        select: {
          id: true,
          userId: true,
          firstName: true,
          departmentId: true,
          weeklyOffConfig: true,
          weeklyOffPattern: { select: { config: true } },
        },
      },
    },
  });
  if (!event) throw new NotFoundError("That attendance record");
  // A 404, not a 403: a reader who can tell "not yours" from "no such thing"
  // can enumerate the roster next door.
  if (visible !== null && !visible.includes(event.employeeId)) {
    throw new NotFoundError("That attendance record");
  }
  if (event.reviewedAt) throw new ValidationError("That has already been reviewed.");

  if (input.verdict === "REJECTED" && !input.note?.trim()) {
    throw new ValidationError("Say why it was not accepted. The employee is told.");
  }

  if (input.verdict === "REJECTED") {
    await refusePayrollLocked(ctx, event.employeeId, event.occurredAt);
  }

  const note =
    input.verdict === "VERIFIED"
      ? `Verified from the selfie${input.note?.trim() ? ` — ${input.note.trim()}` : ""}`
      : `Not accepted — ${input.note!.trim()}`;

  // The day as it is keyed, falling back to the UTC date of the punch for an
  // event that has no row (which a rejection never reaches, but the type
  // allows).
  const dayDate: DateOnly = event.attendanceDay
    ? event.attendanceDay.date.toISOString().slice(0, 10)
    : event.occurredAt.toISOString().slice(0, 10);

  await prisma.$transaction(async (tx) => {
    await tx.attendanceEvent.update({
      where: { id: event.id },
      data: {
        reviewedById: ctx.userId,
        reviewedAt: new Date(),
        reviewNote: note,
        // Verified means it is no longer waiting; rejected means it is no
        // longer waiting *either*, because the administrator has answered it.
        // The outcome is in the note and in the audit row.
        flaggedForReview: input.verdict === "REJECTED",
      },
    });

    if (input.verdict === "REJECTED" && event.attendanceDayId) {
      // What the calendar says the day is, read inside the transaction the
      // same way the mark read it. Rejecting a flagged check-in on a week off
      // while the row was still CHECKED_IN wrote ABSENT for the Sunday, and
      // payroll docked a day nobody was expected to work.
      const dayKind = await dayKindFor(tx, ctx.organizationId!, event.employee, dayDate);
      await unmarkDay(tx, event.attendanceDayId, event.type, note, ctx.userId ?? null, dayKind);
    }
  });

  await writeAudit(ctx, {
    action: "attendance.overridden",
    entityType: "AttendanceEvent",
    entityId: event.id,
    after: { verdict: input.verdict, note },
  });

  if (event.employee.userId) {
    await notify.toUser(event.employee.userId, {
      type: input.verdict === "VERIFIED" ? "attendance.verified" : "attendance.rejected",
      title:
        input.verdict === "VERIFIED"
          ? "Your attendance was confirmed"
          : "Your attendance was taken back",
      body:
        input.verdict === "VERIFIED"
          ? `Your ${dayDate} ${event.type === "CHECK_OUT" ? "check-out" : "check-in"} has been confirmed.`
          : event.type === "CHECK_OUT"
            ? // A rejected check-out reopens the day: the row goes back to
              // "checked in", so checking out again is exactly what fixes it.
              `${note}. Your ${dayDate} check-out has been taken back and the day is open again — check out again when you leave, or ask for it to be corrected.`
            : // The old wording said "needs attention" and the mark stayed where
              // it was. It does not any more, and being told the truth late is
              // how somebody finds out at the end of the month.
              `${note}. Your ${dayDate} mark has been removed — you can mark it again, or ask for it to be corrected.`,
      link: "/me/attendance",
    });
  }

  return { id: event.id, verdict: input.verdict };
}

/**
 * Takes back the punch a rejected mark made.
 *
 * A check-out is taken back on its own: the person was here, and only their
 * leaving time is in doubt. A check-in takes the whole day with it, because a
 * departure from a building somebody never arrived at is not a record worth
 * keeping either.
 *
 * The counters are zeroed with the times, and that is not tidiness. Payroll
 * adds `overtimeMinutes` for every status it sees, including ones it otherwise
 * ignores, so a rejected mark that kept its overtime would be a rejected mark
 * that still got paid extra for the evening.
 *
 * A day whose *nature* is not "somebody worked" is left alone. Rejecting a
 * mark made on a week off or a holiday removes the punch; it does not turn the
 * holiday into an absence.
 *
 * CHECKED_IN and EXTRA_DAY are worked statuses here. A check-in rejected while
 * the day is still open would otherwise keep reading "checked in" with no
 * check-in on it, and the nightly close would then settle a punch that had
 * been taken back. On a working day it becomes ABSENT, which is what the day
 * is once the arrival is gone. On a week off or a holiday it becomes that rest
 * status again -- CHECKED_IN on a Sunday used to fall into the ABSENT arm
 * because only the row's status was consulted, and payroll docked the Sunday.
 *
 * A rejected check-out **reopens the day** rather than scoring it. The row goes
 * back to CHECKED_IN with no check-out and no worked minutes, so the person's
 * real check-out later -- or the nightly close -- settles it as if the rejected
 * punch had never happened. It used to settle at once through
 * `missingCheckout` *and* stamp `overriddenAt`, which froze that verdict: the
 * real check-out that evening was recorded but `recordAttendance` refused to
 * recompute an overridden status, so "you can mark it again" was not true.
 * The review is recorded on the event and in the audit row; the day carries
 * no override for it.
 */
async function unmarkDay(
  tx: Prisma.TransactionClient,
  dayId: string,
  type: string,
  reason: string,
  reviewedById: string | null,
  dayKind: DayKind,
): Promise<void> {
  const day = await tx.attendanceDay.findUnique({
    where: { id: dayId },
    select: { id: true, status: true },
  });
  if (!day) return;

  const workedStatus =
    day.status === "FULL_DAY" || day.status === "HALF_DAY" || day.status === "EXTRA_DAY" || day.status === "CHECKED_IN";
  const clearsTheDay = type === "CHECK_IN";
  // What is left of a working day with no arrival is an absence; what is left
  // of a rest day is the rest day.
  const withoutArrival: AttendanceStatus =
    dayKind === "WEEK_OFF" ? "WEEK_OFF" : dayKind === "HOLIDAY" ? "HOLIDAY" : "ABSENT";

  await tx.attendanceDay.update({
    where: { id: dayId },
    data: clearsTheDay
      ? {
          firstCheckInAt: null,
          lastCheckOutAt: null,
          workedMinutes: 0,
          breakMinutes: 0,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeMinutes: 0,
          isExtraDay: false,
          ...(workedStatus ? { status: withoutArrival, systemStatus: withoutArrival } : {}),
          // Written through the same three columns an override uses, so the
          // grid shows it as a decision somebody took rather than as data
          // that changed by itself -- and so `recordAttendance` stops
          // recomputing the status from punches that are no longer there.
          overriddenById: reviewedById,
          overriddenAt: new Date(),
          overrideReason: reason,
        }
      : {
          lastCheckOutAt: null,
          workedMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeMinutes: 0,
          isExtraDay: false,
          // Open again, exactly as it was between the check-in and the punch
          // that was just taken back. No `overriddenAt`: the next check-out
          // must be allowed to score the day.
          ...(workedStatus
            ? { status: "CHECKED_IN" as const, systemStatus: "CHECKED_IN" as const }
            : {}),
        },
  });
}

/**
 * Refuses to change a day that has already been paid for.
 *
 * "Sirf lock/disburse par roko." A run that is still DRAFT, CALCULATED or
 * APPROVED can be recalculated, and taking a day back before it is locked is
 * ordinary work. A locked run is the organisation's word that the month is
 * closed, and a payslip with money against it is somebody's bank statement.
 */
async function refusePayrollLocked(
  ctx: AuthContext,
  employeeId: string,
  occurredAt: Date,
): Promise<void> {
  const date = occurredAt.toISOString().slice(0, 10);

  const locked = await prisma.payrollRun.findFirst({
    where: {
      organizationId: ctx.organizationId!,
      status: "LOCKED",
      periodStart: { lte: new Date(`${date}T00:00:00.000Z`) },
      periodEnd: { gte: new Date(`${date}T00:00:00.000Z`) },
    },
    select: { periodYear: true, periodMonth: true },
  });
  if (locked) {
    throw new ValidationError(
      `The payroll for ${locked.periodMonth}/${locked.periodYear} is locked, so this day cannot be taken back. Reopen the run first, or correct the day from the attendance grid.`,
    );
  }

  const paid = await prisma.payrollItem.findFirst({
    where: {
      employeeId,
      settlement: { not: "UNPAID" },
      run: {
        organizationId: ctx.organizationId!,
        periodStart: { lte: new Date(`${date}T00:00:00.000Z`) },
        periodEnd: { gte: new Date(`${date}T00:00:00.000Z`) },
      },
    },
    select: { id: true },
  });
  if (paid) {
    throw new ValidationError(
      "This month's salary has already been paid, so this day cannot be taken back. Correct it from the attendance grid and adjust the next run.",
    );
  }
}

export interface MyFlaggedDay {
  eventId: string;
  date: string;
  occurredAt: string;
  reason: string | null;
  /** Reviewed and not accepted, rather than still waiting. */
  rejected: boolean;
  reviewNote: string | null;
}

/**
 * The employee's own unconfirmed marks.
 *
 * Read with no permission beyond having an employee record, because everything
 * it returns is theirs.
 */
export async function myFlaggedDays(ctx: AuthContext): Promise<MyFlaggedDay[]> {
  requireOrg(ctx);
  if (!ctx.employeeId) return [];

  const events = await prisma.attendanceEvent.findMany({
    where: {
      organizationId: ctx.organizationId!,
      employeeId: ctx.employeeId,
      flaggedForReview: true,
      attendanceDayId: { not: null },
    },
    orderBy: { occurredAt: "desc" },
    take: 30,
    select: {
      id: true,
      occurredAt: true,
      faceMatchReason: true,
      reviewedAt: true,
      reviewNote: true,
    },
  });

  return events.map((event) => ({
    eventId: event.id,
    date: event.occurredAt.toISOString().slice(0, 10),
    occurredAt: event.occurredAt.toISOString(),
    reason: event.faceMatchReason,
    rejected: event.reviewedAt !== null,
    reviewNote: event.reviewNote,
  }));
}

/**
 * Clearing your own flagged mark with a code somebody read out to you.
 *
 * The same `AttendancePin` the kiosk uses — it was always keyed on the employee
 * rather than on a device, so nothing new is needed to let it work on a phone.
 * The manager or administrator issues one from the employee's profile, reads it
 * out, and this spends it.
 *
 * Rate limited per employee, which is what makes a six-digit secret defensible:
 * guessing it online is the only avenue and this closes it.
 */
export async function verifyOwnMarkWithPin(
  ctx: AuthContext,
  input: { eventId: string; code: string },
): Promise<{ verified: true }> {
  requireOrg(ctx);
  if (!ctx.employeeId) {
    throw new ValidationError("Your login is not linked to an employee record.");
  }

  await enforce("otpVerify", `attendancepin:${ctx.employeeId}`);

  const event = await prisma.attendanceEvent.findFirst({
    where: {
      id: input.eventId,
      organizationId: ctx.organizationId!,
      // Their own, and only their own.
      employeeId: ctx.employeeId,
      flaggedForReview: true,
      reviewedAt: null,
    },
    select: { id: true, occurredAt: true },
  });
  if (!event) throw new NotFoundError("That attendance record");

  const now = new Date();
  const pin = await prisma.attendancePin.findFirst({
    where: {
      organizationId: ctx.organizationId!,
      employeeId: ctx.employeeId,
      codeHash: hashPin(input.code),
      usedAt: null,
      expiresAt: { gt: now },
    },
    select: { id: true, issuedById: true },
  });

  // One message for wrong, expired and already used. Telling somebody which of
  // the three it was tells them which part to keep trying.
  if (!pin) throw new ValidationError("That PIN is not valid. Ask for a new one.");

  // Spent in its own conditional write, so two attempts racing the same code
  // cannot both win.
  const spent = await prisma.attendancePin.updateMany({
    where: { id: pin.id, usedAt: null },
    data: { usedAt: now },
  });
  if (spent.count === 0) throw new ValidationError("That PIN has already been used.");

  await prisma.attendanceEvent.update({
    where: { id: event.id },
    data: {
      flaggedForReview: false,
      reviewedById: pin.issuedById,
      reviewedAt: now,
      reviewNote: "Verified by PIN",
      // Deliberately not `kioskBypass`. That column answers "how many marks
      // skipped verification"; this is a mark that was verified, late.
    },
  });

  await writeAudit(ctx, {
    action: "attendance.overridden",
    entityType: "AttendanceEvent",
    entityId: event.id,
    metadata: { verifiedBy: "PIN", issuedById: pin.issuedById },
  });

  return { verified: true };
}

export const ATTENDANCE_PIN_MINUTES = PIN_MINUTES;
