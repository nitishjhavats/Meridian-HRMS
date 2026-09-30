import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireSuperadmin, requireWrite } from "@/lib/auth/guard";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { IMAGE_CONSTRAINTS, ingestUpload, storage } from "@/lib/storage";

/**
 * Logos.
 *
 * A logo is the one image in this product that is deliberately public: it has
 * to render on the sign-in screen, before anybody has proved who they are. Both
 * uploads therefore go through the same `ingestUpload` path as everything else
 * — magic-number sniffed, re-encoded, EXIF stripped — because "it is only a
 * logo" is exactly how a file that is not an image ends up being served.
 *
 * The old file is deleted after the new one is stored, not before: a failed
 * upload should leave the previous logo in place rather than none at all.
 */

const LOGO_CONSTRAINTS = {
  ...IMAGE_CONSTRAINTS,
  // A logo does not need to be large, and the smaller cap makes an accidental
  // photograph upload fail early with a clear message.
  maxBytes: 2 * 1024 * 1024,
};

export async function setOrganizationLogo(
  ctx: AuthContext,
  file: { data: Buffer; fileName: string; mimeType: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const previous = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId! },
    select: { logoKey: true },
  });

  const stored = await ingestUpload(file, {
    organizationId: ctx.organizationId!,
    kind: "logos",
    constraints: LOGO_CONSTRAINTS,
  });

  await prisma.organization.update({
    where: { id: ctx.organizationId! },
    data: { logoKey: stored.key },
  });

  if (previous.logoKey && previous.logoKey !== stored.key) {
    await storage().delete(previous.logoKey);
  }

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    after: { logo: "replaced", sizeBytes: stored.size },
  });

  return { logoUrl: `/api/files/${stored.key}` };
}

export async function clearOrganizationLogo(ctx: AuthContext) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId! },
    select: { logoKey: true },
  });
  if (!org.logoKey) return { logoUrl: null };

  await prisma.organization.update({
    where: { id: ctx.organizationId! },
    data: { logoKey: null },
  });
  await storage().delete(org.logoKey);

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    after: { logo: "removed" },
  });

  return { logoUrl: null };
}

/**
 * The platform mark, which is also what the installed app's icon is made from.
 *
 * Stored without an organisation prefix — it belongs to the platform, not to a
 * tenant, and `buildKey(null, …)` puts it under `platform/`.
 */
export async function setPlatformLogo(
  ctx: AuthContext,
  file: { data: Buffer; fileName: string; mimeType: string },
) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.settings.manage");

  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { logoKey: true },
  });

  const stored = await ingestUpload(file, {
    organizationId: null,
    kind: "logos",
    constraints: LOGO_CONSTRAINTS,
  });

  await prisma.platformSetting.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", logoKey: stored.key },
    update: { logoKey: stored.key },
  });

  if (settings?.logoKey && settings.logoKey !== stored.key) {
    await storage().delete(settings.logoKey);
  }

  await writeAudit(ctx, {
    action: "settings.updated",
    entityType: "PlatformSetting",
    entityId: "singleton",
    after: { logo: "replaced", sizeBytes: stored.size },
  });

  return { logoUrl: "/api/branding/platform-logo" };
}

export async function clearPlatformLogo(ctx: AuthContext) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.settings.manage");

  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { logoKey: true },
  });
  if (!settings?.logoKey) return { logoUrl: null };

  await prisma.platformSetting.update({
    where: { id: "singleton" },
    data: { logoKey: null },
  });
  await storage().delete(settings.logoKey);

  await writeAudit(ctx, {
    action: "settings.updated",
    entityType: "PlatformSetting",
    entityId: "singleton",
    after: { logo: "removed" },
  });

  return { logoUrl: null };
}

/** Reads a single-file multipart body the way the other upload routes do. */
/**
 * The company seal.
 *
 * One per organisation, beside the logo — and, since the signature moved here
 * too, beside that. The old split put the seal on the organisation and the
 * signature on each `LetterTemplate`, reasoning that different letters are
 * signed by different people. True in principle and wrong in practice: it meant
 * a signature uploaded once reached exactly one letter type, there was nowhere
 * in organisation settings to upload it at all, and nine of ten letters printed
 * a name with nothing under it. The per-category override still exists for the
 * letter somebody else genuinely signs. Optional throughout: a letter without
 * either prints exactly as it did.
 *
 * Same 1 MB cap and the same `signature` compression profile, which is PNG and
 * does not flatten onto white. That matters more for a stamp than a signature:
 * a round seal re-encoded as JPEG arrives with a white square around it.
 */
const STAMP_CONSTRAINTS = {
  ...IMAGE_CONSTRAINTS,
  maxBytes: 1024 * 1024,
};

export async function setOrganizationStamp(
  ctx: AuthContext,
  file: { data: Buffer; fileName: string; mimeType: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const previous = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId! },
    select: { stampKey: true },
  });

  const stored = await ingestUpload(file, {
    organizationId: ctx.organizationId!,
    kind: "stamps",
    constraints: STAMP_CONSTRAINTS,
  });

  await prisma.organization.update({
    where: { id: ctx.organizationId! },
    data: { stampKey: stored.key },
  });

  // After, never before, like the logo: a failed upload should leave the
  // previous seal in place rather than none at all.
  if (previous.stampKey && previous.stampKey !== stored.key) {
    await storage().delete(previous.stampKey);
  }

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    after: { stamp: previous.stampKey ? "replaced" : "added", sizeBytes: stored.size },
  });

  return { stampUrl: `/api/files/${stored.key}` };
}

export async function clearOrganizationStamp(ctx: AuthContext) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId! },
    select: { stampKey: true },
  });
  if (!org.stampKey) return { stampUrl: null };

  await prisma.organization.update({
    where: { id: ctx.organizationId! },
    data: { stampKey: null },
  });
  await storage().delete(org.stampKey);

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    after: { stamp: "removed" },
  });

  return { stampUrl: null };
}

export async function readUploadedFile(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("Choose an image to upload.");

  return {
    data: Buffer.from(await file.arrayBuffer()),
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
  };
}

/**
 * The authorised signatory's signature, once for the whole organisation.
 *
 * Same constraints as the stamp — PNG, no flattening onto white — because a
 * signature scanned on paper and re-encoded as JPEG arrives with a grey box
 * around it, which on a letterhead looks exactly like a mistake.
 *
 * Every letter template falls back to this. A template that carries its own
 * still wins, so nothing an organisation has already set is disturbed.
 */
export async function setOrganizationSignature(
  ctx: AuthContext,
  file: { data: Buffer; fileName: string; mimeType: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const previous = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId! },
    select: { signatureKey: true },
  });

  const stored = await ingestUpload(file, {
    organizationId: ctx.organizationId!,
    kind: "signatures",
    constraints: STAMP_CONSTRAINTS,
  });

  await prisma.organization.update({
    where: { id: ctx.organizationId! },
    data: { signatureKey: stored.key },
  });

  // After, never before: a failed upload should leave the previous signature in
  // place rather than none at all.
  if (previous.signatureKey && previous.signatureKey !== stored.key) {
    await storage().delete(previous.signatureKey);
  }

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    after: {
      signature: previous.signatureKey ? "replaced" : "added",
      sizeBytes: stored.size,
    },
  });

  return { signatureUrl: `/api/files/${stored.key}` };
}

export async function clearOrganizationSignature(ctx: AuthContext) {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId! },
    select: { signatureKey: true },
  });
  if (!org.signatureKey) return { signatureUrl: null };

  await prisma.organization.update({
    where: { id: ctx.organizationId! },
    data: { signatureKey: null },
  });
  await storage().delete(org.signatureKey);

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    after: { signature: "removed" },
  });

  return { signatureUrl: null };
}
