import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertSameTenant,
  hasPermission,
  requireOrg,
  requirePermission,
  requireWritable,
  visibleEmployeeIds,
} from "@/lib/auth/guard";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { decryptOptional, encryptField } from "@/lib/crypto/field";
import {
  COMPRESSION,
  IMAGE_CONSTRAINTS,
  buildKey,
  compressImage,
  describeSaving,
  storage,
  validateUpload,
} from "@/lib/storage";
import { faceEngine, warmFaceEngine } from "@/lib/face/engine";
import { checkEnrolmentPhoto, type FaceDescriptor } from "@/domain/attendance/faceMatch";

/**
 * Enrolling the reference photo that attendance selfies are matched against.
 *
 * The descriptor is biometric data about a person, so it is treated accordingly:
 *
 *   • stored encrypted, never returned to any client, never in an audit row;
 *   • derived server-side from the uploaded photo — a client cannot supply one;
 *   • removable, and removing it deletes both the descriptor and the photo;
 *   • recorded with a consent timestamp when the employee enrols themselves.
 *
 * The photo itself is kept because HR needs to see what was enrolled when a
 * match starts failing.
 */

export interface EnrolmentResult {
  enrolledAt: Date;
  photoKey: string;
  /** Detector confidence on the reference photo, for HR's reassurance. */
  quality: number;
}

/** Only these people may enrol a face: HR/Admin for anyone, or the employee themselves. */
async function assertMayEnrol(ctx: AuthContext, employeeId: string): Promise<void> {
  requireOrg(ctx);
  if (hasPermission(ctx, "employee.update")) return;
  if (ctx.employeeId === employeeId) return;
  throw new ForbiddenError("You can only manage your own reference photo.");
}

export async function enrolFace(
  ctx: AuthContext,
  employeeId: string,
  file: { data: Buffer; fileName: string; mimeType: string },
  options: { consent?: boolean } = {},
): Promise<EnrolmentResult> {
  await assertMayEnrol(ctx, employeeId);
  requireWritable(ctx);

  /**
   * No consent, no enrolment.
   *
   * `faceConsentAt` existed from the beginning and was theatre: it was written
   * only when somebody enrolled their own face, because the client set the flag
   * programmatically with no checkbox and no consent text anywhere. When HR
   * enrolled somebody else — the normal case — it was simply not written, and
   * the enrolment succeeded regardless. The column was read in exactly one
   * place, to display it. Nothing checked it here, and nothing checked it at
   * match time either.
   *
   * A face is biometric data. Under the SPDI Rules it is sensitive personal
   * data and consent is required before collection, and under the DPDP Act it
   * needs notice and consent from the person it belongs to. A timestamp that
   * records nothing and blocks nothing satisfies neither.
   *
   * So it is refused here, at the only door in. The caller passes the flag only
   * when a person has actually been shown the statement and ticked the box.
   */
  if (!options.consent) {
    throw new ValidationError(
      "A reference photo can only be enrolled with the employee's consent. Ask them to confirm they agree to face verification first.",
    );
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, organizationId: true, firstName: true, lastName: true, userId: true, facePhotoKey: true },
  });
  assertSameTenant(ctx, employee, "That employee");

  validateUpload(file.data, file.mimeType, file.fileName, IMAGE_CONSTRAINTS);

  // Compress first, then read the face from the *compressed* image. The bytes
  // that get stored are the bytes the descriptor came from, so a later
  // re-derivation cannot disagree with the enrolment.
  const compressed = await compressImage(file.data, COMPRESSION.reference);

  // A photo we cannot read a single clear face from must not become an
  // enrolment at all — nothing is written until this passes.
  const candidate = await faceEngine().describe(compressed.data);
  const check = checkEnrolmentPhoto(candidate);
  if (!check.ok || !candidate.descriptor) {
    throw new ValidationError(check.message ?? "That photo cannot be used as a reference.");
  }

  const key = buildKey(ctx.organizationId, "avatars", compressed.extension);
  await storage().put(key, compressed.data, compressed.mimeType, {
    organizationId: ctx.organizationId,
    kind: "avatars",
  });

  const previousKey = employee!.facePhotoKey;
  const now = new Date();

  await prisma.employee.update({
    where: { id: employeeId },
    data: {
      facePhotoKey: key,
      // Encrypted at rest. Nothing outside this module ever sees the numbers.
      faceDescriptorCipher: encryptField(JSON.stringify(candidate.descriptor)),
      faceEnrolledAt: now,
      faceEnrolledById: ctx.userId,
      // Always set now, because enrolment is refused without it above.
      faceConsentAt: now,
    },
  });

  // Replacing an enrolment removes the old image rather than leaving orphaned
  // biometric material on disk.
  if (previousKey && previousKey !== key) {
    await storage().delete(previousKey).catch(() => undefined);
  }

  await writeAudit(ctx, {
    action: "employee.updated",
    entityType: "Employee",
    entityId: employeeId,
    // The descriptor is deliberately absent — only the fact of enrolment.
    metadata: {
      faceEnrolled: true,
      quality: Number(candidate.detectionScore.toFixed(3)),
      stored: describeSaving(compressed),
    },
  });

  if (employee!.userId && employee!.userId !== ctx.userId) {
    await notify.toUser(employee!.userId, {
      type: "face.enrolled",
      title: "Your reference photo was updated",
      body: "Attendance selfies will now be checked against this photo.",
      link: "/me/attendance",
    });
  }

  return { enrolledAt: now, photoKey: key, quality: candidate.detectionScore };
}

export async function removeFaceEnrolment(ctx: AuthContext, employeeId: string): Promise<void> {
  await assertMayEnrol(ctx, employeeId);
  requireWritable(ctx);

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, organizationId: true, facePhotoKey: true, faceEnrolledAt: true },
  });
  assertSameTenant(ctx, employee, "That employee");
  if (!employee!.faceEnrolledAt) throw new NotFoundError("A reference photo");

  await prisma.employee.update({
    where: { id: employeeId },
    data: {
      facePhotoKey: null,
      faceDescriptorCipher: null,
      faceEnrolledAt: null,
      faceEnrolledById: null,
      faceConsentAt: null,
    },
  });

  if (employee!.facePhotoKey) {
    await storage().delete(employee!.facePhotoKey).catch(() => undefined);
  }

  await writeAudit(ctx, {
    action: "employee.updated",
    entityType: "Employee",
    entityId: employeeId,
    metadata: { faceEnrolmentRemoved: true },
  });
}

/**
 * Loads the enrolled descriptors for comparison.
 *
 * Internal to the server — there is no API path that returns these, because a
 * leaked descriptor would let someone forge a match against a stolen photo.
 */
export async function loadEnrolledDescriptors(employeeId: string): Promise<FaceDescriptor[]> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { faceDescriptorCipher: true },
  });
  if (!employee?.faceDescriptorCipher) return [];

  const plain = decryptOptional(employee.faceDescriptorCipher);
  if (!plain) return [];

  try {
    const parsed = JSON.parse(plain) as unknown;
    if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "number")) return [];
    return [parsed as FaceDescriptor];
  } catch {
    return [];
  }
}

export interface EnrolmentStatus {
  enrolled: boolean;
  enrolledAt: Date | null;
  photoKey: string | null;
  consentAt: Date | null;
  engineAvailable: boolean;
}

export async function getEnrolmentStatus(
  ctx: AuthContext,
  employeeId: string,
): Promise<EnrolmentStatus> {
  requireOrg(ctx);
  if (!hasPermission(ctx, "employee.read.all") && ctx.employeeId !== employeeId) {
    requirePermission(ctx, "employee.read.team");
  }

  // The permission says *whether* this person may read a colleague's enrolment;
  // this says *which* colleagues. Without it, `employee.read.team` was read as
  // "any employee in the organisation", so a team lead could ask about anybody
  // -- and the answer carries `photoKey`, which `/api/files` will then serve to
  // anyone in the same tenant. That is somebody's reference face photo.
  //
  // 404 rather than 403, like `getEmployee`: saying "you may not see this
  // person" confirms the person exists.
  const visible = await visibleEmployeeIds(ctx, "employee.read");
  if (visible !== null && !visible.includes(employeeId)) {
    throw new NotFoundError("That employee");
  }

  const [employee, engineAvailable] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: employeeId },
      select: {
        organizationId: true,
        facePhotoKey: true,
        faceEnrolledAt: true,
        faceConsentAt: true,
      },
    }),
    // Models load lazily on first use; ask them to load rather than reporting
    // "unavailable" simply because nobody has checked a face in this process yet.
    warmFaceEngine(),
  ]);
  assertSameTenant(ctx, employee, "That employee");

  return {
    enrolled: employee!.faceEnrolledAt != null,
    enrolledAt: employee!.faceEnrolledAt,
    photoKey: employee!.facePhotoKey,
    consentAt: employee!.faceConsentAt,
    engineAvailable,
  };
}
