import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { storage } from "@/lib/storage";

/**
 * Attendance selfie retention.
 *
 * A selfie proves who marked attendance *at the time*. Once the payroll period
 * it belongs to is closed and any dispute window has passed, keeping a photo of
 * somebody's face serves no purpose and is a liability — so it is deleted.
 *
 * What survives is the **record**, not the image: the timestamp, the location,
 * the distance and the face-match score all stay, so historical attendance and
 * payroll remain fully auditable. Only the pixels go.
 *
 * Reference photos used for enrolment are *not* touched here. They are deleted
 * when the enrolment is removed, which is a different lifecycle.
 */

export const DEFAULT_RETENTION_DAYS = 60;

export interface PurgeSummary {
  scanned: number;
  purged: number;
  failed: number;
  retentionDays: number;
  cutoff: Date;
  freedBytes: number;
}

/**
 * Deletes selfies older than the retention window.
 *
 * Idempotent and resumable: rows are marked `selfiePurgedAt` only after their
 * file is gone, so an interrupted run simply picks up where it stopped, and a
 * file already missing counts as purged rather than as a failure.
 */
export async function purgeExpiredSelfies(
  options: { retentionDays?: number; batchSize?: number; now?: Date } = {},
): Promise<PurgeSummary> {
  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { selfieRetentionDays: true },
  });

  const retentionDays =
    options.retentionDays ?? settings?.selfieRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  const batchSize = options.batchSize ?? 500;

  const expired = await prisma.attendanceEvent.findMany({
    where: {
      occurredAt: { lt: cutoff },
      selfieKey: { not: null },
      selfiePurgedAt: null,
      /**
       * A photo somebody is still waiting on is not expired.
       *
       * The window exists so this product does not hold biometric data longer
       * than it needs to, and that argument is sound right up to the point
       * where the photo *is* what is needed: an administrator asked to approve
       * or reject a mark from a selfie cannot do either if the sweep took it
       * first. Rejecting now removes somebody's attendance, so deciding blind
       * is not an option -- and an undecidable mark is one that stays flagged
       * for ever.
       *
       * Answered marks are purged on schedule, so this holds back the few that
       * are open rather than the file itself.
       */
      NOT: { flaggedForReview: true, reviewedAt: null },
    },
    orderBy: { occurredAt: "asc" },
    take: batchSize,
    select: { id: true, selfieKey: true },
  });

  let purged = 0;
  let failed = 0;
  let freedBytes = 0;

  for (const event of expired) {
    if (!event.selfieKey) continue;
    try {
      // Ask the size before deleting so the summary can report what was freed.
      const file = await prisma.fileObject.findUnique({
        where: { key: event.selfieKey },
        select: { sizeBytes: true },
      });

      await storage().delete(event.selfieKey);
      await prisma.attendanceEvent.update({
        where: { id: event.id },
        data: { selfieKey: null, selfiePurgedAt: now },
      });

      freedBytes += file?.sizeBytes ?? 0;
      purged++;
    } catch (error) {
      // One stuck file must not stop the sweep.
      console.error("[retention] could not purge selfie", { eventId: event.id, error });
      failed++;
    }
  }

  return { scanned: expired.length, purged, failed, retentionDays, cutoff, freedBytes };
}

/** How much selfie storage is currently held, and how much is already expired. */
export async function getSelfieStorageReport(now = new Date()) {
  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { selfieRetentionDays: true },
  });
  const retentionDays = settings?.selfieRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  const [stored, expired, purged] = await Promise.all([
    prisma.fileObject.aggregate({
      where: { kind: "selfies" },
      _sum: { sizeBytes: true },
      _count: { _all: true },
    }),
    prisma.attendanceEvent.count({
      where: { occurredAt: { lt: cutoff }, selfieKey: { not: null }, selfiePurgedAt: null },
    }),
    prisma.attendanceEvent.count({ where: { selfiePurgedAt: { not: null } } }),
  ]);

  return {
    retentionDays,
    cutoff,
    storedCount: stored._count._all,
    storedBytes: stored._sum.sizeBytes ?? 0,
    awaitingPurge: expired,
    alreadyPurged: purged,
  };
}

/** Removes file rows nothing references any more — orphans from failed uploads. */
export async function purgeOrphanFiles(now = new Date()): Promise<number> {
  // Only consider files old enough that an in-flight upload cannot be caught.
  const cutoff = new Date(now.getTime() - 3_600_000);

  const candidates = await prisma.fileObject.findMany({
    where: { createdAt: { lt: cutoff }, kind: { in: ["selfies", "avatars"] } },
    select: { key: true },
    take: 1_000,
  });
  if (candidates.length === 0) return 0;

  const keys = candidates.map((c) => c.key);
  const [referencedSelfies, referencedAvatars, referencedPhotos] = await Promise.all([
    prisma.attendanceEvent.findMany({
      where: { selfieKey: { in: keys } },
      select: { selfieKey: true },
    }),
    prisma.employee.findMany({
      where: { facePhotoKey: { in: keys } },
      select: { facePhotoKey: true },
    }),
    prisma.employee.findMany({ where: { photoKey: { in: keys } }, select: { photoKey: true } }),
  ]);

  const referenced = new Set(
    [
      ...referencedSelfies.map((r) => r.selfieKey),
      ...referencedAvatars.map((r) => r.facePhotoKey),
      ...referencedPhotos.map((r) => r.photoKey),
    ].filter((k): k is string => k != null),
  );

  const orphans = keys.filter((key) => !referenced.has(key));
  if (orphans.length === 0) return 0;

  const result = await prisma.fileObject.deleteMany({ where: { key: { in: orphans } } });
  return result.count;
}

// ------------------------------------------------------- the rest of the trail

/** Failed and successful sign-in attempts, with the email typed and the IP. */
export const LOGIN_EVENT_RETENTION_DAYS = 90;

/**
 * Everything about *where* a mark happened, on the same clock as the selfie.
 *
 * The selfie purge above deliberately kept the record and dropped only the
 * pixels, and that was right about the attendance *fact* — the timestamp and
 * the verdict are payroll evidence and must survive. It was wrong about the
 * rest of the row. Coordinates, the IP address and a `deviceInfo` blob holding
 * user agent, platform and screen resolution were kept for the life of the
 * record, which is to say for ever: a per-day map of where each employee stood,
 * accumulating indefinitely, long after any dispute it could settle.
 *
 * So they age out together. What is left afterwards is what a payroll auditor
 * actually needs — the day, the time, whether the fence passed, whether the
 * face matched — with the surveillance value gone.
 *
 * `distanceMeters` and `withinGeofence` stay: they are the *verdict*, not the
 * position, and a day that was disputed a year later still has to be able to
 * say the fence was checked and passed.
 */
export async function purgeExpiredLocationTrail(
  options: { retentionDays?: number; now?: Date } = {},
): Promise<{ events: number; cutoff: Date; retentionDays: number }> {
  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { selfieRetentionDays: true },
  });
  const retentionDays =
    options.retentionDays ?? settings?.selfieRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  const result = await prisma.attendanceEvent.updateMany({
    where: {
      occurredAt: { lt: cutoff },
      // Only rows that still hold something to clear, so a re-run is free.
      OR: [
        { latitude: { not: null } },
        { longitude: { not: null } },
        { ipAddress: { not: null } },
        { deviceInfo: { not: Prisma.DbNull } },
      ],
    },
    data: {
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      ipAddress: null,
      deviceInfo: Prisma.DbNull,
    },
  });

  return { events: result.count, cutoff, retentionDays };
}

/**
 * Sign-in attempts older than ninety days.
 *
 * `LoginEvent` records every attempt including the failures, with the email
 * somebody typed and the IP they typed it from. That is exactly what you want
 * when investigating an incident this quarter and exactly what you do not want
 * to be holding three years later. Ninety days is long enough to answer "who
 * has been trying to get into this account", which is the question it exists
 * for.
 *
 * `AuditLog` is deliberately *not* purged here — it is the payroll audit trail,
 * and statutory retention applies to it. Its identifying columns are aged out
 * separately below.
 */
export async function purgeExpiredLoginEvents(
  options: { retentionDays?: number; now?: Date } = {},
): Promise<{ deleted: number; cutoff: Date }> {
  const retentionDays = options.retentionDays ?? LOGIN_EVENT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  const result = await prisma.loginEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return { deleted: result.count, cutoff };
}

/** How long an audit row keeps the IP and user agent it was made from. */
export const AUDIT_IDENTIFIER_RETENTION_DAYS = 180;

/**
 * The audit row survives; the address it came from does not.
 *
 * *What* changed, *who* changed it and *when* is the record, and it stays for
 * as long as the payroll it documents. The requester's IP and user agent are
 * incident-response detail with a much shorter useful life, and keeping them
 * for years turns an audit log into a movement history.
 */
export async function purgeAuditIdentifiers(
  options: { retentionDays?: number; now?: Date } = {},
): Promise<{ rows: number; cutoff: Date }> {
  const retentionDays = options.retentionDays ?? AUDIT_IDENTIFIER_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  const result = await prisma.auditLog.updateMany({
    where: {
      createdAt: { lt: cutoff },
      OR: [{ ipAddress: { not: null } }, { userAgent: { not: null } }],
    },
    data: { ipAddress: null, userAgent: null },
  });

  return { rows: result.count, cutoff };
}
