import type { KioskRosterScope } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { signInUrl } from "@/services/employees/credentials";
import { checkPassword } from "@/domain/password";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { generateTemporaryPassword, hashPassword } from "@/lib/auth/password";
import { randomToken } from "@/lib/crypto/field";
import { writeAudit } from "@/lib/audit";
import { todayInZone, type DateOnly } from "@/domain/date";
import {
  attendancePolicySchema,
  describeArrivals,
  shiftMinutes,
  type ArrivalExample,
  type AttendancePolicy,
} from "@/domain/attendance/policy";
import { faceMatchPolicySchema, type FaceMatchPolicy } from "@/domain/attendance/faceMatch";
import { getAttendanceRules, savePolicyVersion, type AttendanceRules } from "@/services/policy";

/**
 * The organisation's attendance rules, as an admin edits them.
 *
 * Until this existed the ATTENDANCE policy was written exactly once, by
 * `provisionTenant`, and `attendance.settings.manage` was a permission that
 * gated nothing. Everything here is therefore a first writer, which is why the
 * schema and its cross-field refinements went in first: the thresholds interact,
 * and a bad combination does not error, it silently mis-scores everybody's day.
 */

export interface AttendanceSettings {
  policy: AttendancePolicy;
  faceMatch: FaceMatchPolicy;
  /** Nominal working minutes implied by the shift, once the break is out. */
  shiftMinutes: number;
  /** What the current thresholds do to a few arrival times. */
  examples: ArrivalExample[];
  effectiveFrom: DateOnly;
  /**
   * Active employees with no work location attached.
   *
   * This is the hole `requireGps` never closed: it forces coordinates to be
   * sent, not to be near anything, so somebody with no location marks from
   * wherever they are and the record cannot tell you it was never checked.
   * Naming them here is the difference between a setting and a discovery.
   */
  withoutWorkLocation: { total: number; names: string[] };
}

export async function getAttendanceSettings(ctx: AuthContext): Promise<AttendanceSettings> {
  requireOrg(ctx);
  // Read, not write — a manager who may see settings but not change them still
  // gets a truthful picture, and the write path guards itself. It is still a
  // permission: a kiosk holds neither, and has no reason to read the rules.
  requirePermission(ctx, "org.settings.read");
  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const today = todayInZone(timezone);
  const rules = await getAttendanceRules(ctx, today);

  const { faceMatch, ...policy } = rules as AttendanceRules;

  const unfenced = await prisma.employee.findMany({
    where: { organizationId: ctx.organizationId!, active: true, workLocationId: null },
    select: { firstName: true, lastName: true },
    orderBy: { firstName: "asc" },
  });

  return {
    policy,
    faceMatch,
    shiftMinutes: shiftMinutes(policy).duration,
    examples: describeArrivals(policy),
    effectiveFrom: today,
    withoutWorkLocation: {
      total: unfenced.length,
      // Enough to recognise the problem without printing a directory.
      names: unfenced
        .slice(0, 8)
        .map((e) => [e.firstName, e.lastName].filter(Boolean).join(" ")),
    },
  };
}

export interface UpdateAttendanceSettingsInput {
  policy: unknown;
  faceMatch: unknown;
  effectiveFrom?: DateOnly;
  note?: string;
}

export async function updateAttendanceSettings(
  ctx: AuthContext,
  input: UpdateAttendanceSettingsInput,
): Promise<AttendanceSettings> {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.settings.manage", "attendance");

  const parsed = attendancePolicySchema.safeParse(input.policy);
  if (!parsed.success) {
    throw new ValidationError("These attendance rules cannot be saved as they are.", {
      issues: parsed.error.issues.slice(0, 12).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const face = faceMatchPolicySchema.safeParse(input.faceMatch);
  if (!face.success) {
    throw new ValidationError("These face-verification settings cannot be saved as they are.", {
      issues: face.error.issues.slice(0, 12).map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }

  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const today = todayInZone(timezone);
  const effectiveFrom = input.effectiveFrom ?? today;

  // Backdating would rewrite the rules under days that were already scored and
  // may already have been paid. Forward only.
  if (effectiveFrom < today) {
    throw new ValidationError(
      "Attendance rules can start today or later, not in the past — days already recorded were scored under the rules in force at the time.",
    );
  }

  // Kiosk marking is meaningless with face verification off: the kiosk's whole
  // safeguard is that the face has to match, because the device itself is not
  // proof of who is standing at it.
  if (parsed.data.marking.kiosk && face.data.mode === "OFF") {
    throw new ValidationError(
      "The office device cannot be used while face verification is off — on a shared screen, the face is the only thing identifying who is marking attendance.",
    );
  }

  const before = await getAttendanceSettings(ctx);

  const { version } = await savePolicyVersion(
    ctx,
    "ATTENDANCE",
    { ...parsed.data, faceMatch: face.data },
    { effectiveFrom, note: input.note },
  );

  await writeAudit(ctx, {
    action: "attendance.settings.updated",
    entityType: "OrgPolicyVersion",
    entityId: `${ctx.organizationId}:ATTENDANCE:${version}`,
    before: { policy: before.policy, faceMatch: before.faceMatch },
    after: { policy: parsed.data, faceMatch: face.data },
    metadata: { version, effectiveFrom },
  });

  return getAttendanceSettings(ctx);
}

/* -------------------------------------------------------------------------- */
/*  Office devices                                                             */
/* -------------------------------------------------------------------------- */

export interface KioskDeviceRow {
  id: string;
  label: string;
  email: string;
  workLocation: string;
  /** By id as well as by name, because an edit form has to pre-select it. */
  workLocationId: string;
  rosterScope: KioskRosterScope;
  createdAt: Date;
  lastSeenAt: Date | null;
}

export async function listKioskDevices(ctx: AuthContext): Promise<KioskDeviceRow[]> {
  requireOrg(ctx);
  /**
   * The estate is a settings screen, not a roster.
   *
   * This was the one function in the file with no permission check, so every
   * signed-in member of the organisation -- the kiosk account included, which
   * passes `requireOrg` -- could read every device's label and generated login
   * address.
   */
  requirePermission(ctx, "org.settings.read");

  const rows = await prisma.kioskDevice.findMany({
    where: { organizationId: ctx.organizationId!, revokedAt: null },
    select: {
      id: true,
      label: true,
      rosterScope: true,
      createdAt: true,
      lastSeenAt: true,
      user: { select: { email: true } },
      workLocation: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    email: r.user.email,
    workLocation: r.workLocation.name,
    workLocationId: r.workLocation.id,
    rosterScope: r.rosterScope,
    createdAt: r.createdAt,
    lastSeenAt: r.lastSeenAt,
  }));
}

export interface CreatedKioskDevice {
  id: string;
  label: string;
  email: string;
  /** Shown once. Nothing stores it in the clear, here or anywhere else. */
  password: string;
  /**
   * The organisation's own door, so whoever walks to the device knows where to
   * type these. It was missing, and "go to the HRMS" is not an instruction --
   * a device is set up once, usually by somebody who will not do it again for a
   * year.
   */
  signInUrl: string;
}

/**
 * A login for a screen.
 *
 * The account is a `KIOSK`, which holds two permissions and nothing else — it
 * cannot open a payslip or a document even if somebody walks up to the device
 * and starts typing URLs. It gets no `Employee` record, so it consumes no seat.
 *
 * The email is generated rather than asked for: it is an address nobody will
 * ever receive mail at, and asking an administrator to invent one invites them
 * to use their own.
 */
export async function createKioskDevice(
  ctx: AuthContext,
  input: { label: string; workLocationId: string; rosterScope?: KioskRosterScope },
): Promise<CreatedKioskDevice> {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.settings.manage", "attendance");

  const label = input.label.trim();
  if (label.length < 2) {
    throw new ValidationError("Give the device a name you will recognise, like “Reception iPad”.");
  }

  const location = await prisma.workLocation.findFirst({
    where: { id: input.workLocationId, organizationId: ctx.organizationId! },
    select: { id: true, name: true, active: true },
  });
  if (!location) throw new NotFoundError("That work location");
  if (!location.active) {
    throw new ValidationError("That work location is switched off, so a device cannot stand there.");
  }

  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "device";
  // Lower-cased deliberately: the sign-in route normalises the address it is
  // given, so an email with a capital in it could never be matched back and the
  // device would be unable to log in at all.
  const email = `kiosk-${slug}-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "")}@device.local`;
  const password = generateTemporaryPassword();

  const device = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        organizationId: ctx.organizationId!,
        email,
        name: label,
        passwordHash: await hashPassword(password),
        role: "KIOSK",
        status: "ACTIVE",
        // A screen cannot be asked to choose a new password at first sign-in.
        mustChangePassword: false,
      },
      select: { id: true },
    });

    return tx.kioskDevice.create({
      data: {
        organizationId: ctx.organizationId!,
        userId: user.id,
        workLocationId: location.id,
        label,
        // Asked at creation. The column default is ORGANISATION so that the
        // migration does not narrow the devices already standing in offices;
        // the form offers this one first.
        rosterScope: input.rosterScope ?? "WORK_LOCATION",
        createdById: ctx.userId,
      },
      select: { id: true },
    });
  });

  await writeAudit(ctx, {
    action: "attendance.kiosk.created",
    entityType: "KioskDevice",
    entityId: device.id,
    after: {
      label,
      workLocation: location.name,
      rosterScope: input.rosterScope ?? "WORK_LOCATION",
      email,
    },
  });

  return { id: device.id, label, email, password, signInUrl: signInUrl(ctx.organization?.slug ?? null) };
}

/**
 * Changing a device that is already standing somewhere.
 *
 * There was no way to change one at all: the lifecycle was create, regenerate
 * the password, revoke. So renaming a screen or moving it to another floor
 * meant revoking it and creating a new one, which mints a new login and a new
 * password for a device somebody has to walk over to and sign in again --
 * while `structure.ts` tells an administrator to "Move or revoke it" and
 * nothing implemented the first half of that sentence.
 *
 * Changing the branch a device serves is deliberately part of this rather than
 * a separate control. It is one question about one screen -- which building is
 * this, and who does it list -- and answering half of it is what produces a
 * device labelled Reception that lists the warehouse.
 */
export async function updateKioskDevice(
  ctx: AuthContext,
  deviceId: string,
  input: { label?: string; workLocationId?: string; rosterScope?: KioskRosterScope },
): Promise<KioskDeviceRow> {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.settings.manage", "attendance");

  const device = await prisma.kioskDevice.findFirst({
    where: { id: deviceId, organizationId: ctx.organizationId!, revokedAt: null },
    select: {
      id: true,
      label: true,
      userId: true,
      rosterScope: true,
      workLocation: { select: { id: true, name: true } },
    },
  });
  if (!device) throw new NotFoundError("That device");

  const label = input.label?.trim();
  if (label !== undefined && label.length < 2) {
    throw new ValidationError("Give the device a name you will recognise, like \u201cReception iPad\u201d.");
  }

  let location = device.workLocation;
  if (input.workLocationId && input.workLocationId !== device.workLocation.id) {
    const moved = await prisma.workLocation.findFirst({
      where: { id: input.workLocationId, organizationId: ctx.organizationId! },
      select: { id: true, name: true, active: true },
    });
    if (!moved) throw new NotFoundError("That work location");
    if (!moved.active) {
      throw new ValidationError(
        "That work location is switched off, so a device cannot stand there.",
      );
    }
    location = { id: moved.id, name: moved.name };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.kioskDevice.update({
      where: { id: device.id },
      data: {
        ...(label !== undefined ? { label } : {}),
        ...(location.id !== device.workLocation.id ? { workLocationId: location.id } : {}),
        ...(input.rosterScope ? { rosterScope: input.rosterScope } : {}),
      },
      select: {
        id: true,
        label: true,
        rosterScope: true,
        createdAt: true,
        lastSeenAt: true,
        user: { select: { email: true } },
        workLocation: { select: { id: true, name: true } },
      },
    });

    // The device's login carries the label as its display name, and a rename
    // that left the account behind would show the old name in the audit trail
    // of every mark the screen makes from then on.
    if (label !== undefined) {
      await tx.user.update({ where: { id: device.userId }, data: { name: label } });
    }

    return row;
  });

  await writeAudit(ctx, {
    action: "attendance.kiosk.updated",
    entityType: "KioskDevice",
    entityId: device.id,
    before: {
      label: device.label,
      workLocation: device.workLocation.name,
      rosterScope: device.rosterScope,
    },
    after: {
      label: updated.label,
      workLocation: updated.workLocation.name,
      rosterScope: updated.rosterScope,
    },
  });

  return {
    id: updated.id,
    label: updated.label,
    email: updated.user.email,
    workLocation: updated.workLocation.name,
    workLocationId: updated.workLocation.id,
    rosterScope: updated.rosterScope,
    createdAt: updated.createdAt,
    lastSeenAt: updated.lastSeenAt,
  };
}

/**
 * Taking a device out of service.
 *
 * The account is disabled and its sessions are cut in the same breath. A
 * thirty-day session is the whole reason a kiosk is convenient, and it is also
 * the reason revoking one has to take effect now rather than at expiry.
 */
/**
 * A new password for a device that is already set up.
 *
 * The one shown at creation is never recoverable — nothing stores the
 * plaintext, which is the right design — so a password lost at nine in the
 * morning used to mean revoking the device and creating another one, which
 * changes its identity and orphans whatever is on the screen. This changes only
 * the password.
 *
 * Every live session on that device is revoked in the same transaction. A
 * password reset that leaves the old session working is not a reset.
 */
export async function regenerateKioskPassword(
  ctx: AuthContext,
  deviceId: string,
  /**
   * A password the administrator chose, rather than a generated one.
   *
   * Both are useful and neither replaces the other. A generated password is
   * stronger and is what a device gets on the day it is set up; a chosen one is
   * what somebody standing in front of a tablet with a two-line keyboard
   * actually needs, and refusing them one means they write the generated one on
   * a sticky note beside the screen -- which is worse than any password.
   *
   * It is checked against the same rules every other password in this product
   * is, so "chosen" does not mean "weak".
   */
  chosen?: string,
): Promise<{ label: string; email: string; password: string; signInUrl: string }> {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.settings.manage", "attendance");

  const device = await prisma.kioskDevice.findFirst({
    where: { id: deviceId, organizationId: ctx.organizationId!, revokedAt: null },
    select: { id: true, label: true, userId: true, user: { select: { email: true } } },
  });
  if (!device) throw new NotFoundError("That device");

  let password: string;
  if (chosen === undefined) {
    password = generateTemporaryPassword();
  } else {
    const verdict = checkPassword(chosen);
    if (!verdict.ok) throw new ValidationError(verdict.problems[0] ?? "That password is too weak.");
    password = chosen;
  }
  const passwordHash = await hashPassword(password);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: device.userId },
      data: {
        passwordHash,
        passwordChangedAt: now,
        // A screen cannot be asked to choose a new password at first sign-in.
        mustChangePassword: false,
        status: "ACTIVE",
      },
    });
    await tx.session.updateMany({
      where: { userId: device.userId, revokedAt: null },
      data: { revokedAt: now, revokedById: ctx.userId },
    });
  });

  // Its own action, not `kiosk.created`. Reusing the creation action made a
  // password reset read as a new device in the audit log -- which is exactly
  // the event somebody reviewing that log is trying to tell apart.
  await writeAudit(ctx, {
    action: "attendance.kiosk.password_regenerated",
    entityType: "KioskDevice",
    entityId: device.id,
    after: { label: device.label, passwordRegenerated: true },
  });

  return {
    label: device.label,
    email: device.user.email,
    password,
    signInUrl: signInUrl(ctx.organization?.slug ?? null),
  };
}

export async function revokeKioskDevice(ctx: AuthContext, deviceId: string): Promise<void> {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.settings.manage", "attendance");

  const device = await prisma.kioskDevice.findFirst({
    where: { id: deviceId, organizationId: ctx.organizationId!, revokedAt: null },
    select: { id: true, label: true, userId: true },
  });
  if (!device) throw new NotFoundError("That device");

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.kioskDevice.update({ where: { id: device.id }, data: { revokedAt: now } });
    await tx.user.update({ where: { id: device.userId }, data: { status: "DISABLED" } });
    await tx.session.updateMany({
      where: { userId: device.userId, revokedAt: null },
      data: { revokedAt: now, revokedById: ctx.userId },
    });
  });

  await writeAudit(ctx, {
    action: "attendance.kiosk.revoked",
    entityType: "KioskDevice",
    entityId: device.id,
    before: { label: device.label },
  });
}
