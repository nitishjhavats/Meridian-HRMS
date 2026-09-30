import type { AssetStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, requireWritable, requireWrite } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { formatPaise } from "@/domain/money";
import { type DateOnly, todayInZone } from "@/domain/date";

/**
 * Company property.
 *
 * The register exists so that an exit can answer "what is still out?" without
 * anybody remembering. That is why `recoveryPaise` sits on the *assignment*
 * rather than the asset: what a laptop is worth to recover depends on how long
 * this person had it, not on what it cost when it was bought.
 */

export const ASSET_CATEGORIES = [
  "LAPTOP",
  "DESKTOP",
  "MONITOR",
  "PHONE",
  "SIM",
  "ACCESS_CARD",
  "FURNITURE",
  "VEHICLE",
  "TOOL",
  "OTHER",
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  LAPTOP: "Laptop",
  DESKTOP: "Desktop",
  MONITOR: "Monitor",
  PHONE: "Phone",
  SIM: "SIM card",
  ACCESS_CARD: "Access card",
  FURNITURE: "Furniture",
  VEHICLE: "Vehicle",
  TOOL: "Tool",
  OTHER: "Other",
};

/**
 * Where "please acknowledge it" lands.
 *
 * The dashboard's "Issued to you" card, which is the one asset screen an
 * ordinary employee can open. Named here so the notification and the card
 * cannot drift apart.
 */
export const MY_ASSETS_LINK = "/dashboard#my-assets";

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ register

export interface AssetRow {
  id: string;
  assetTag: string;
  name: string;
  category: string;
  categoryLabel: string;
  serialNumber: string | null;
  status: AssetStatus;
  valuePaise: number | null;
  note: string | null;
  /** The open assignment, if the asset is out. */
  heldBy: {
    assignmentId: string;
    employeeId: string;
    name: string;
    code: string;
    issuedOn: DateOnly;
    dueOn: DateOnly | null;
    overdue: boolean;
    acknowledged: boolean;
  } | null;
}

export async function listAssets(
  ctx: AuthContext,
  filters: { status?: AssetStatus; employeeId?: string } = {},
): Promise<AssetRow[]> {
  requireOrg(ctx);
  requirePermission(ctx, "asset.manage");

  const assets = await prisma.asset.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.employeeId
        ? { assignments: { some: { employeeId: filters.employeeId, returnedOn: null } } }
        : {}),
    },
    orderBy: [{ status: "asc" }, { assetTag: "asc" }],
    take: 500,
    select: {
      id: true,
      assetTag: true,
      name: true,
      category: true,
      serialNumber: true,
      status: true,
      valuePaise: true,
      note: true,
      assignments: {
        where: { returnedOn: null },
        take: 1,
        select: {
          id: true,
          issuedOn: true,
          dueOn: true,
          acknowledgedAt: true,
          employee: {
            select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
          },
        },
      },
    },
  });

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");

  return assets.map((a) => {
    const open = a.assignments[0];
    return {
      id: a.id,
      assetTag: a.assetTag,
      name: a.name,
      category: a.category,
      categoryLabel: CATEGORY_LABELS[a.category] ?? a.category,
      serialNumber: a.serialNumber,
      status: a.status,
      valuePaise: a.valuePaise,
      note: a.note,
      heldBy: open
        ? {
            assignmentId: open.id,
            employeeId: open.employee.id,
            name: employeeName(open.employee, "—"),
            code: open.employee.employeeCode,
            issuedOn: toDateOnly(open.issuedOn),
            dueOn: open.dueOn ? toDateOnly(open.dueOn) : null,
            overdue: Boolean(open.dueOn && toDateOnly(open.dueOn) < today),
            acknowledged: open.acknowledgedAt != null,
          }
        : null,
    };
  });
}

export async function createAsset(
  ctx: AuthContext,
  input: {
    assetTag: string;
    name: string;
    category: string;
    serialNumber?: string;
    valuePaise?: number;
    note?: string;
  },
) {
  requireOrg(ctx);
  requireWrite(ctx, "asset.manage", "assets");

  const assetTag = input.assetTag.trim().toUpperCase();
  if (assetTag.length < 2) throw new ValidationError("Give the asset a tag, e.g. LAP-014.");

  const existing = await prisma.asset.findFirst({
    where: { organizationId: ctx.organizationId, assetTag },
    select: { id: true },
  });
  if (existing) throw new ConflictError(`${assetTag} is already in the register.`);

  const asset = await prisma.asset.create({
    data: {
      organizationId: ctx.organizationId,
      assetTag,
      name: input.name.trim(),
      category: input.category,
      serialNumber: input.serialNumber?.trim() || null,
      valuePaise: input.valuePaise ?? null,
      note: input.note?.trim() || null,
      status: "AVAILABLE",
    },
  });

  await writeAudit(ctx, {
    action: "asset.updated",
    entityType: "Asset",
    entityId: asset.id,
    after: { assetTag, name: asset.name, category: asset.category },
  });

  return { id: asset.id, assetTag };
}

export async function setAssetStatus(ctx: AuthContext, id: string, status: AssetStatus, note?: string) {
  requireOrg(ctx);
  requireWrite(ctx, "asset.manage", "assets");

  const asset = await prisma.asset.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, status: true, assetTag: true, assignments: { where: { returnedOn: null }, select: { id: true } } },
  });
  if (!asset) throw new NotFoundError("That asset");

  if (status === "AVAILABLE" && asset.assignments.length > 0) {
    throw new ConflictError("That asset is still issued to somebody. Record its return first.");
  }

  await prisma.asset.update({
    where: { id },
    data: { status, ...(note !== undefined ? { note: note.trim() || null } : {}) },
  });

  await writeAudit(ctx, {
    action: "asset.updated",
    entityType: "Asset",
    entityId: id,
    before: { status: asset.status },
    after: { status, assetTag: asset.assetTag },
  });

  return { id, status };
}

// ------------------------------------------------------------------ issuing

export async function issueAsset(
  ctx: AuthContext,
  input: {
    assetId: string;
    employeeId: string;
    issuedOn: DateOnly;
    dueOn?: DateOnly;
    conditionOnIssue?: string;
    note?: string;
  },
) {
  requireOrg(ctx);
  requireWrite(ctx, "asset.manage", "assets");

  const [asset, employee] = await Promise.all([
    prisma.asset.findFirst({
      where: { id: input.assetId, organizationId: ctx.organizationId },
      select: {
        id: true,
        assetTag: true,
        name: true,
        status: true,
        assignments: { where: { returnedOn: null }, select: { id: true } },
      },
    }),
    prisma.employee.findFirst({
      where: { id: input.employeeId, organizationId: ctx.organizationId },
      select: { id: true, userId: true, employeeCode: true },
    }),
  ]);
  if (!asset) throw new NotFoundError("That asset");
  if (!employee) throw new NotFoundError("That employee");

  if (asset.assignments.length > 0) {
    throw new ConflictError(`${asset.assetTag} is already issued to somebody.`);
  }
  if (asset.status === "RETIRED" || asset.status === "LOST") {
    throw new ConflictError(`${asset.assetTag} is marked ${asset.status.toLowerCase()}.`);
  }

  const assignment = await prisma.$transaction(async (tx) => {
    const created = await tx.assetAssignment.create({
      data: {
        organizationId: ctx.organizationId!,
        assetId: input.assetId,
        employeeId: input.employeeId,
        issuedOn: toDate(input.issuedOn),
        dueOn: input.dueOn ? toDate(input.dueOn) : null,
        conditionOnIssue: input.conditionOnIssue?.trim() || null,
        note: input.note?.trim() || null,
        createdById: ctx.userId,
      },
    });
    // Status follows the assignment, so the register cannot disagree with itself.
    await tx.asset.update({ where: { id: input.assetId }, data: { status: "ASSIGNED" } });
    return created;
  });

  await writeAudit(ctx, {
    action: "asset.issued",
    entityType: "Asset",
    entityId: input.assetId,
    after: { assetTag: asset.assetTag, employeeCode: employee.employeeCode, issuedOn: input.issuedOn },
  });

  if (employee.userId) {
    // To the dashboard card, not to `/assets`: the register needs
    // `asset.manage`, which the person being handed a laptop does not hold, so
    // "please acknowledge it" used to land on "You do not have access".
    await notify.toUser(employee.userId, {
      type: "asset.issued",
      title: "Company property issued to you",
      body: `${asset.name} (${asset.assetTag}). Please acknowledge it.`,
      link: MY_ASSETS_LINK,
    });
  }

  return { id: assignment.id };
}

export async function returnAsset(
  ctx: AuthContext,
  assignmentId: string,
  input: { returnedOn: DateOnly; conditionOnReturn?: string; recoveryPaise?: number; note?: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "asset.manage", "assets");

  const assignment = await prisma.assetAssignment.findFirst({
    where: { id: assignmentId, organizationId: ctx.organizationId },
    select: {
      id: true,
      assetId: true,
      returnedOn: true,
      issuedOn: true,
      asset: { select: { assetTag: true } },
    },
  });
  if (!assignment) throw new NotFoundError("That assignment");
  if (assignment.returnedOn) throw new ConflictError("That asset has already been returned.");
  if (toDate(input.returnedOn) < assignment.issuedOn) {
    throw new ValidationError("The return date cannot be before the issue date.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.assetAssignment.update({
      where: { id: assignmentId },
      data: {
        returnedOn: toDate(input.returnedOn),
        conditionOnReturn: input.conditionOnReturn?.trim() || null,
        recoveryPaise: input.recoveryPaise ?? null,
        ...(input.note !== undefined ? { note: input.note.trim() || null } : {}),
      },
    });
    // Damaged goods go to repair rather than straight back into circulation.
    await tx.asset.update({
      where: { id: assignment.assetId },
      data: { status: input.recoveryPaise && input.recoveryPaise > 0 ? "IN_REPAIR" : "AVAILABLE" },
    });
  });

  await writeAudit(ctx, {
    action: "asset.returned",
    entityType: "Asset",
    entityId: assignment.assetId,
    after: {
      assetTag: assignment.asset.assetTag,
      returnedOn: input.returnedOn,
      recoveryPaise: input.recoveryPaise ?? 0,
    },
  });

  return { id: assignmentId };
}

export interface MyAssetRow {
  assignmentId: string;
  /** The route that takes the acknowledge action is keyed on the asset. */
  assetId: string;
  assetTag: string;
  name: string;
  categoryLabel: string;
  issuedOn: DateOnly;
  dueOn: DateOnly | null;
  overdue: boolean;
  acknowledged: boolean;
}

/**
 * What the signed-in person currently holds.
 *
 * No permission beyond being the employee: this is their own record, the same
 * way `acknowledgeAssignment` is. A login with no employee row holds nothing.
 */
export async function assetsIssuedToMe(ctx: AuthContext): Promise<MyAssetRow[]> {
  requireOrg(ctx);
  requireModule(ctx, "assets");
  if (!ctx.employeeId) return [];

  const assignments = await prisma.assetAssignment.findMany({
    where: { organizationId: ctx.organizationId, employeeId: ctx.employeeId, returnedOn: null },
    orderBy: { issuedOn: "asc" },
    select: {
      id: true,
      issuedOn: true,
      dueOn: true,
      acknowledgedAt: true,
      asset: { select: { id: true, assetTag: true, name: true, category: true } },
    },
  });

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");

  return assignments.map((a) => ({
    assignmentId: a.id,
    assetId: a.asset.id,
    assetTag: a.asset.assetTag,
    name: a.asset.name,
    categoryLabel: CATEGORY_LABELS[a.asset.category] ?? a.asset.category,
    issuedOn: toDateOnly(a.issuedOn),
    dueOn: a.dueOn ? toDateOnly(a.dueOn) : null,
    overdue: Boolean(a.dueOn && toDateOnly(a.dueOn) < today),
    acknowledged: a.acknowledgedAt != null,
  }));
}

/** The employee confirming they have it — their side of the record. */
export async function acknowledgeAssignment(ctx: AuthContext, assignmentId: string) {
  requireOrg(ctx);
  // A write like the others in this module: not while the module is off for
  // this person, and not while the subscription has the organisation read-only.
  requireModule(ctx, "assets");
  requireWritable(ctx);

  const assignment = await prisma.assetAssignment.findFirst({
    where: { id: assignmentId, organizationId: ctx.organizationId, employeeId: ctx.employeeId ?? "" },
    select: { id: true, acknowledgedAt: true },
  });
  if (!assignment) throw new NotFoundError("That assignment");
  if (assignment.acknowledgedAt) return { id: assignmentId };

  await prisma.assetAssignment.update({
    where: { id: assignmentId },
    data: { acknowledgedAt: new Date() },
  });

  return { id: assignmentId };
}

/**
 * What somebody still holds.
 *
 * Called by the exit screen: this is the list that must be empty, or valued,
 * before a settlement is honest.
 */
export async function outstandingFor(ctx: AuthContext, employeeId: string) {
  requireOrg(ctx);

  const assignments = await prisma.assetAssignment.findMany({
    where: { organizationId: ctx.organizationId, employeeId, returnedOn: null },
    orderBy: { issuedOn: "asc" },
    select: {
      id: true,
      issuedOn: true,
      acknowledgedAt: true,
      asset: { select: { assetTag: true, name: true, valuePaise: true } },
    },
  });

  return assignments.map((a) => ({
    assignmentId: a.id,
    assetTag: a.asset.assetTag,
    name: a.asset.name,
    issuedOn: toDateOnly(a.issuedOn),
    acknowledged: a.acknowledgedAt != null,
    valueLabel: a.asset.valuePaise != null ? formatPaise(a.asset.valuePaise) : null,
  }));
}
