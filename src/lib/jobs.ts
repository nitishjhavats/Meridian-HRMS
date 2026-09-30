import {
  getSelfieStorageReport,
  purgeAuditIdentifiers,
  purgeExpiredLocationTrail,
  purgeExpiredLoginEvents,
  purgeExpiredSelfies,
  purgeOrphanFiles,
} from "@/services/attendance/retention";
import { purgeExpiredExports } from "@/services/export";
import { seedYearlyHolidays } from "@/services/org/yearlyHolidays";
import { purgeExpired } from "@/lib/ratelimit";
import { flagUpcomingConfirmations } from "@/services/employees/probation";
import { purgeExpiredChatMessages } from "@/services/chat/retention";
import { closeAttendanceDays } from "@/services/attendance/dayClose";
import { prisma } from "@/lib/db/prisma";

/**
 * The maintenance pass.
 *
 * Extracted from `scripts/run-jobs.ts` so the same work can be triggered over
 * HTTP inside the running server. A container has no `.env` file to read and no
 * `tsx` to run TypeScript with, so a scheduler that shells into it cannot use
 * the script — but it can make one authenticated request, and everything here
 * is already compiled into the server it would be talking to.
 *
 * Every step is idempotent. An interrupted run is not a problem; the next one
 * picks up whatever was left.
 */

export interface JobsSummary {
  selfies: { purged: number; freedBytes: number; awaitingPurge: number; retentionDays: number };
  orphanFiles: number;
  /** Attendance rows whose coordinates, IP and device details were cleared. */
  locationTrail: number;
  /** Sign-in attempts older than the window, deleted. */
  loginEvents: number;
  /** Audit rows whose IP and user agent were cleared, the row itself kept. */
  auditIdentifiers: number;
  expiredExports: { expired: number; freedBytes: number };
  rateLimitRows: number;
  /** People whose probation or training ends within the week, and who was told. */
  confirmationsDue: { organizations: number; employees: number };
  /** Messages and emptied threads removed by the thirty-day age-out. */
  chat: { messages: number; threads: number; retentionDays: number };
  /** National holidays filled in for the year ahead, so no calendar runs out. */
  holidays: { organizations: number; created: number; throughYear: number };
  /**
   * Days closed: absences written for people who never marked, and open
   * check-ins settled through each organisation's missing-checkout rule.
   */
  attendance: {
    organizations: number;
    absentCreated: number;
    openDaysClosed: number;
    /** Working days left blank because approved leave covers them. */
    leaveWithoutRow: number;
    /** Working days left blank because the person could not have marked by any path. */
    unmarkable: number;
  };
  durationMs: number;
}

export async function runMaintenanceJobs(): Promise<JobsSummary> {
  const startedAt = Date.now();

  const before = await getSelfieStorageReport();

  // Selfies age out; the attendance record they belong to does not. The purge
  // is batched, so this loops until a pass finds nothing left to do.
  let purged = 0;
  let freedBytes = 0;
  for (;;) {
    const result = await purgeExpiredSelfies();
    purged += result.purged;
    freedBytes += result.freedBytes;
    if (result.scanned === 0 || result.purged === 0) break;
  }

  /**
   * The rest of the trail ages out with the pixels.
   *
   * Selfies had a retention window and nothing else did — coordinates, IPs and
   * a device fingerprint accumulated for the life of the row, which for an
   * attendance record is indefinitely.
   */
  const locationTrail = await purgeExpiredLocationTrail();
  const loginEvents = await purgeExpiredLoginEvents();
  const auditIdentifiers = await purgeAuditIdentifiers();

  const orphanFiles = await purgeOrphanFiles();
  const expiredExports = await purgeExpiredExports();
  const rateLimitRows = await purgeExpired();

  // Not a purge: the only step here that tells somebody something rather than
  // forgetting something. `confirmationDate` was written at creation and read
  // by nothing, so a probation ended and nobody was told.
  const confirmationsDue = await flagUpcomingConfirmations();

  // The only thing in the product that removes a chat message. Nobody can
  // delete one; this is the whole of the forgetting.
  const chat = await purgeExpiredChatMessages();

  /**
   * The calendar, kept a year ahead.
   *
   * Not a purge like everything else here, and it belongs anyway: it is the
   * one thing that has to happen on a schedule and that nobody would remember
   * in January. It seeds a year once and records that it did, so a holiday an
   * organisation switched off is never put back.
   */
  const holidays = await seedYearlyHolidays();

  /**
   * The close of the day.
   *
   * The one step here that writes an attendance fact rather than forgetting
   * one. Runs after everything else so a purge cannot race it, and before the
   * stamp so a night it failed is a night the health check calls stale.
   */
  const attendance = await closeAttendanceDays({ now: new Date() });

  // Stamped last, so it means "every step above finished", not "something
  // started". A live container and a cron that quietly stopped firing look
  // identical from outside; this is the difference, and `/api/health?deep=1`
  // reports it so one failed night is visible instead of silent.
  // Upsert, not update: the settings row is created lazily by the first read of
  // `/platform/settings`, so on a fresh instance it may not exist yet -- and an
  // `update` would throw here, after every job above had already succeeded,
  // reporting a broken maintenance run that in fact did all of its work.
  await prisma.platformSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", lastMaintenanceAt: new Date() },
    update: { lastMaintenanceAt: new Date() },
  });

  return {
    selfies: {
      purged,
      freedBytes,
      awaitingPurge: before.awaitingPurge,
      retentionDays: before.retentionDays,
    },
    locationTrail: locationTrail.events,
    loginEvents: loginEvents.deleted,
    auditIdentifiers: auditIdentifiers.rows,
    orphanFiles,
    expiredExports,
    rateLimitRows,
    confirmationsDue,
    chat: { messages: chat.messages, threads: chat.threads, retentionDays: chat.retentionDays },
    holidays,
    attendance: {
      organizations: attendance.organizations,
      absentCreated: attendance.absentCreated,
      openDaysClosed: attendance.openDaysClosed,
      leaveWithoutRow: attendance.leaveWithoutRow,
      unmarkable: attendance.unmarkable,
    },
    durationMs: Date.now() - startedAt,
  };
}
