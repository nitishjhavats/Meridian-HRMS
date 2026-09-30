import type { DocumentStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { ingestUpload, storage } from "@/lib/storage";
import { type DateOnly, todayInZone } from "@/domain/date";

/**
 * The document vault.
 *
 * Two rules shape this file, both from the spec:
 *
 *   1. An employee can upload and can *ask* for a deletion, but cannot delete.
 *      Personnel records that the subject can remove are not records.
 *   2. Replacing a document adds a version rather than overwriting one. The old
 *      file stays reachable, because "we have your PAN card" and "we had a
 *      different PAN card in March" are different facts.
 */

export const DOCUMENT_CATEGORIES = [
  "IDENTITY",
  "ADDRESS",
  "EDUCATION",
  "EMPLOYMENT",
  "BANK",
  "CONTRACT",
  "MEDICAL",
  "OTHER",
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  IDENTITY: "Identity proof",
  ADDRESS: "Address proof",
  EDUCATION: "Education",
  EMPLOYMENT: "Previous employment",
  BANK: "Bank details",
  CONTRACT: "Contracts and letters",
  MEDICAL: "Medical",
  OTHER: "Other",
};

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ reading

export interface DocumentRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  category: string;
  categoryLabel: string;
  title: string;
  status: DocumentStatus;
  expiresOn: DateOnly | null;
  /** True when the expiry has passed — the reason this field exists at all. */
  expired: boolean;
  expiringSoon: boolean;
  currentVersion: number;
  versions: {
    version: number;
    fileName: string;
    sizeBytes: number;
    mimeType: string;
    url: string;
    uploadedAt: string;
  }[];
  note: string | null;
  verifiedAt: string | null;
  deletionRequested: boolean;
  updatedAt: string;
}

export interface DocumentFilters {
  employeeId?: string;
  category?: string;
  status?: DocumentStatus;
}

const EXPIRY_WARNING_DAYS = 30;

export async function listDocuments(
  ctx: AuthContext,
  filters: DocumentFilters = {},
): Promise<DocumentRow[]> {
  requireOrg(ctx);

  const visible = await visibleEmployeeIds(ctx, "document.read");
  const where: Record<string, unknown> = { organizationId: ctx.organizationId };
  if (visible !== null) where.employeeId = { in: visible };
  if (filters.employeeId) {
    if (visible !== null && !visible.includes(filters.employeeId)) return [];
    where.employeeId = filters.employeeId;
  }
  if (filters.category) where.category = filters.category;
  if (filters.status) where.status = filters.status;

  const documents = await prisma.employeeDocument.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }],
    take: 500,
    select: {
      id: true,
      employeeId: true,
      category: true,
      title: true,
      status: true,
      expiresOn: true,
      currentVersion: true,
      note: true,
      verifiedAt: true,
      updatedAt: true,
      employee: {
        select: { employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
      },
      versions: {
        orderBy: { version: "desc" },
        select: {
          version: true,
          fileKey: true,
          fileName: true,
          sizeBytes: true,
          mimeType: true,
          createdAt: true,
        },
      },
      deletionRequests: {
        where: { status: "PENDING" },
        select: { id: true },
      },
    },
  });

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const warnFrom = new Date(`${today}T00:00:00Z`);
  warnFrom.setUTCDate(warnFrom.getUTCDate() + EXPIRY_WARNING_DAYS);
  const warnBefore = toDateOnly(warnFrom);

  return documents.map((d) => {
    const expiresOn = d.expiresOn ? toDateOnly(d.expiresOn) : null;
    return {
      id: d.id,
      employeeId: d.employeeId,
      employeeName: employeeName(d.employee, "—"),
      employeeCode: d.employee.employeeCode,
      category: d.category,
      categoryLabel: CATEGORY_LABELS[d.category as DocumentCategory] ?? d.category,
      title: d.title,
      status: d.status,
      expiresOn,
      expired: Boolean(expiresOn && expiresOn < today),
      expiringSoon: Boolean(expiresOn && expiresOn >= today && expiresOn <= warnBefore),
      currentVersion: d.currentVersion,
      versions: d.versions.map((v) => ({
        version: v.version,
        fileName: v.fileName,
        sizeBytes: v.sizeBytes,
        mimeType: v.mimeType,
        url: `/api/files/${v.fileKey}`,
        uploadedAt: v.createdAt.toISOString(),
      })),
      note: d.note,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      deletionRequested: d.deletionRequests.length > 0,
      updatedAt: d.updatedAt.toISOString(),
    };
  });
}

// ------------------------------------------------------------------ uploading

export interface UploadDocumentInput {
  employeeId: string;
  category: string;
  title: string;
  expiresOn?: DateOnly | null;
  note?: string;
  /** Adds a version to this document instead of creating a new one. */
  replacesDocumentId?: string;
}

export async function uploadDocument(
  ctx: AuthContext,
  file: { data: Buffer; fileName: string; mimeType: string },
  input: UploadDocumentInput,
) {
  requireOrg(ctx);

  const forSelf = input.employeeId === ctx.employeeId;
  const canUploadAny = ctx.permissions.has("document.upload.any");
  if (!forSelf && !canUploadAny) {
    throw new ForbiddenError("You can only upload documents to your own file.");
  }
  if (forSelf && !canUploadAny && !ctx.permissions.has("document.upload.self")) {
    throw new ForbiddenError("You do not have permission to upload documents.");
  }
  requireWrite(ctx, "document.read.self", "documents");

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, organizationId: ctx.organizationId },
    select: { id: true, userId: true },
  });
  if (!employee) throw new NotFoundError("That employee");

  const stored = await ingestUpload(file, {
    organizationId: ctx.organizationId,
    kind: "documents",
  });

  const result = await prisma.$transaction(async (tx) => {
    if (input.replacesDocumentId) {
      const existing = await tx.employeeDocument.findFirst({
        where: { id: input.replacesDocumentId, organizationId: ctx.organizationId! },
        select: { id: true, employeeId: true, currentVersion: true },
      });
      if (!existing) throw new NotFoundError("That document");
      if (existing.employeeId !== input.employeeId) {
        throw new ValidationError("That document belongs to a different employee.");
      }

      const version = existing.currentVersion + 1;
      await tx.documentVersion.create({
        data: {
          documentId: existing.id,
          version,
          fileKey: stored.key,
          fileName: file.fileName,
          mimeType: stored.mimeType,
          sizeBytes: stored.size,
          checksum: stored.checksum,
          uploadedById: ctx.userId,
        },
      });

      // A replacement is unverified again: verification applied to the file
      // that was checked, not to the document as a concept.
      const updated = await tx.employeeDocument.update({
        where: { id: existing.id },
        data: {
          currentVersion: version,
          status: "PENDING_VERIFICATION",
          verifiedById: null,
          verifiedAt: null,
          ...(input.expiresOn !== undefined
            ? { expiresOn: input.expiresOn ? new Date(input.expiresOn) : null }
            : {}),
          ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
        },
      });
      return { document: updated, version, replaced: true };
    }

    const document = await tx.employeeDocument.create({
      data: {
        organizationId: ctx.organizationId!,
        employeeId: input.employeeId,
        category: input.category,
        title: input.title.trim(),
        status: "PENDING_VERIFICATION",
        expiresOn: input.expiresOn ? new Date(input.expiresOn) : null,
        note: input.note?.trim() || null,
        uploadedById: ctx.userId,
        currentVersion: 1,
        versions: {
          create: {
            version: 1,
            fileKey: stored.key,
            fileName: file.fileName,
            mimeType: stored.mimeType,
            sizeBytes: stored.size,
            checksum: stored.checksum,
            uploadedById: ctx.userId,
          },
        },
      },
    });
    return { document, version: 1, replaced: false };
  });

  await writeAudit(ctx, {
    action: "document.uploaded",
    entityType: "EmployeeDocument",
    entityId: result.document.id,
    after: {
      title: result.document.title,
      category: result.document.category,
      version: result.version,
      sizeBytes: stored.size,
    },
  });

  return {
    id: result.document.id,
    version: result.version,
    replaced: result.replaced,
    sizeBytes: stored.size,
    originalBytes: stored.originalBytes,
  };
}

// ------------------------------------------------------------------ verifying

export async function verifyDocument(
  ctx: AuthContext,
  documentId: string,
  decision: "VERIFIED" | "REJECTED",
  note?: string,
) {
  requireOrg(ctx);
  requireWrite(ctx, "document.verify", "documents");

  const document = await prisma.employeeDocument.findFirst({
    where: { id: documentId, organizationId: ctx.organizationId },
    select: { id: true, title: true, status: true, employee: { select: { userId: true } } },
  });
  if (!document) throw new NotFoundError("That document");

  await prisma.employeeDocument.update({
    where: { id: documentId },
    data: {
      status: decision,
      verifiedById: ctx.userId,
      verifiedAt: new Date(),
      ...(note !== undefined ? { note: note.trim() || null } : {}),
    },
  });

  await writeAudit(ctx, {
    action: "document.verified",
    entityType: "EmployeeDocument",
    entityId: documentId,
    before: { status: document.status },
    after: { status: decision, note: note?.trim() || null },
  });

  if (document.employee.userId) {
    await notify.toUser(document.employee.userId, {
      type: "document.verified",
      title: decision === "VERIFIED" ? "Document verified" : "Document rejected",
      body:
        decision === "VERIFIED"
          ? `${document.title} has been verified.`
          : `${document.title} was not accepted.${note ? ` ${note}` : ""}`,
      link: "/me/documents",
    });
  }

  return { id: documentId, status: decision };
}

// ------------------------------------------------------------------ deletion

/**
 * Asking for a document to be removed.
 *
 * This is the whole reason deletion is a two-step process: the person a record
 * is about is exactly the person who should not be able to erase it quietly.
 */
export async function requestDeletion(ctx: AuthContext, documentId: string, reason?: string) {
  requireOrg(ctx);
  requireWrite(ctx, "document.delete.request", "documents");

  const document = await prisma.employeeDocument.findFirst({
    where: { id: documentId, organizationId: ctx.organizationId },
    select: { id: true, title: true, employeeId: true },
  });
  if (!document) throw new NotFoundError("That document");

  const canDeleteAny = ctx.permissions.has("document.delete.approve");
  if (!canDeleteAny && document.employeeId !== ctx.employeeId) {
    throw new ForbiddenError("You can only ask for your own documents to be removed.");
  }

  const existing = await prisma.documentDeletionRequest.findFirst({
    where: { documentId, status: "PENDING" },
    select: { id: true },
  });
  if (existing) throw new ConflictError("A deletion request for that document is already open.");

  const request = await prisma.documentDeletionRequest.create({
    data: {
      organizationId: ctx.organizationId,
      documentId,
      requestedById: ctx.userId,
      reason: reason?.trim() || null,
    },
  });

  await writeAudit(ctx, {
    action: "document.deletion_requested",
    entityType: "EmployeeDocument",
    entityId: documentId,
    after: { reason: reason?.trim() || null },
  });

  await notify.toOrgRoles(ctx.organizationId, ["HR_MANAGER", "ADMIN", "ORG_OWNER"], {
    type: "document.deletion_requested",
    title: "Document deletion requested",
    body: `${ctx.name ?? "Someone"} asked to remove “${document.title}”.`,
    link: "/documents",
  });

  return { id: request.id };
}

export async function decideDeletion(
  ctx: AuthContext,
  requestId: string,
  decision: "APPROVED" | "REJECTED",
  note?: string,
) {
  requireOrg(ctx);
  requireWrite(ctx, "document.delete.approve", "documents");

  const request = await prisma.documentDeletionRequest.findFirst({
    where: { id: requestId, organizationId: ctx.organizationId },
    include: {
      document: {
        select: { id: true, title: true, versions: { select: { fileKey: true } } },
      },
    },
  });
  if (!request) throw new NotFoundError("That deletion request");
  if (request.status !== "PENDING") {
    throw new ConflictError(`That request was already ${request.status.toLowerCase()}.`);
  }

  await prisma.documentDeletionRequest.update({
    where: { id: requestId },
    data: {
      status: decision,
      reviewedById: ctx.userId,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || null,
    },
  });

  if (decision === "APPROVED") {
    // The files go first: a row without its blobs is recoverable confusion, a
    // blob without its row is an orphan nobody will ever find again.
    const store = storage();
    for (const version of request.document.versions) {
      await store.delete(version.fileKey).catch(() => undefined);
    }
    await prisma.employeeDocument.delete({ where: { id: request.document.id } });
  }

  await writeAudit(ctx, {
    action: decision === "APPROVED" ? "document.deleted" : "document.deletion_approved",
    entityType: "EmployeeDocument",
    entityId: request.document.id,
    before: { title: request.document.title },
    after: { decision, note: note?.trim() || null },
  });

  return { id: requestId, status: decision };
}

export async function listDeletionRequests(ctx: AuthContext) {
  requireOrg(ctx);
  // A read. `requireWrite` here refused the whole page the moment a trial
  // ended or a payment lapsed -- under a banner that had promised read-only.
  requirePermission(ctx, "document.delete.approve");
  requireModule(ctx, "documents");

  const requests = await prisma.documentDeletionRequest.findMany({
    where: { organizationId: ctx.organizationId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      reason: true,
      createdAt: true,
      document: {
        select: {
          title: true,
          category: true,
          employee: { select: { employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } } },
        },
      },
    },
  });

  return requests.map((r) => ({
    id: r.id,
    reason: r.reason,
    requestedAt: r.createdAt.toISOString(),
    title: r.document.title,
    category: r.document.category,
    employeeName: employeeName(r.document.employee, "—"),
    employeeCode: r.document.employee.employeeCode,
  }));
}
