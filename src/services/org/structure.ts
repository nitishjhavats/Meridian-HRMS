import { prisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/uniqueViolation";
import type { AuthContext } from "@/lib/auth/context";
import { assertSameTenant, requireOrg, requireWrite } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { liveReportingWhere } from "@/domain/reporting/window";
import { LIVE_PRIMARY_LINE } from "@/domain/reporting/primaryLine";

/**
 * Departments, designations and work locations.
 *
 * `org.structure.manage` has been declared and granted to Admins since the
 * permission list was written, and gated nothing, because the screens behind it
 * were never built. Everything else in the product assumes these exist: the
 * employee form offers them, the spreadsheet importer resolves them by name, and
 * a work location is what a kiosk stands at and what a geofence is measured
 * against.
 *
 * Nothing is ever deleted. A department with a year of payroll behind it cannot
 * be removed without orphaning that history, so it is deactivated: it stops
 * being offered for new assignments and stays attached to everything that
 * already refers to it.
 */

export interface StructureSnapshot {
  departments: { id: string; name: string; code: string | null; active: boolean; employees: number }[];
  designations: {
    id: string;
    title: string;
    level: number;
    active: boolean;
    employees: number;
    /** Designations this one reports to. The routing graph, not the ordering. */
    reportsTo: { id: string; title: string; active: boolean }[];
  }[];
  workLocations: {
    id: string;
    name: string;
    address: string | null;
    addressLine2: string | null;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    requireGps: boolean;
    requireSelfie: boolean;
    active: boolean;
    isPrimary: boolean;
    employees: number;
    kiosks: number;
  }[];
}

export async function getStructure(ctx: AuthContext): Promise<StructureSnapshot> {
  requireOrg(ctx);
  const where = { organizationId: ctx.organizationId! };

  const [departments, designations, locations] = await Promise.all([
    prisma.department.findMany({
      where,
      select: { id: true, name: true, code: true, active: true, _count: { select: { employees: true } } },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
    prisma.designation.findMany({
      where,
      select: {
        id: true,
        title: true,
        level: true,
        active: true,
        _count: { select: { employees: true } },
        reportsTo: {
          select: { reportsTo: { select: { id: true, title: true, active: true } } },
        },
      },
      orderBy: [{ active: "desc" }, { level: "asc" }, { title: "asc" }],
    }),
    prisma.workLocation.findMany({
      where,
      select: {
        id: true,
        name: true,
        address: true,
        addressLine2: true,
        latitude: true,
        longitude: true,
        radiusMeters: true,
        requireGps: true,
        requireSelfie: true,
        active: true,
        isPrimary: true,
        _count: { select: { employees: true, kioskDevices: true } },
      },
      // The default branch first: it is the one an admin is looking for when
      // they open this screen to find out where new people are landing.
      orderBy: [{ active: "desc" }, { isPrimary: "desc" }, { name: "asc" }],
    }),
  ]);

  return {
    departments: departments.map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
      active: d.active,
      employees: d._count.employees,
    })),
    designations: designations.map((d) => ({
      id: d.id,
      title: d.title,
      level: d.level,
      active: d.active,
      employees: d._count.employees,
      reportsTo: d.reportsTo.map((r) => r.reportsTo),
    })),
    workLocations: locations.map((l) => ({
      id: l.id,
      name: l.name,
      address: l.address,
      addressLine2: l.addressLine2,
      latitude: Number(l.latitude),
      longitude: Number(l.longitude),
      radiusMeters: l.radiusMeters,
      requireGps: l.requireGps,
      requireSelfie: l.requireSelfie,
      active: l.active,
      isPrimary: l.isPrimary,
      employees: l._count.employees,
      kiosks: l._count.kioskDevices,
    })),
  };
}

/* ------------------------------- departments ------------------------------ */

export async function saveDepartment(
  ctx: AuthContext,
  input: { id?: string; name: string; code?: string; active?: boolean },
) {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the department a name.");

  const clash = await prisma.department.findFirst({
    where: { organizationId: ctx.organizationId!, name, ...(input.id ? { NOT: { id: input.id } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`There is already a department called ${name}.`);

  if (input.id) {
    const existing = await prisma.department.findUnique({ where: { id: input.id } });
    assertSameTenant(ctx, existing, "That department");
  }

  const data = { name, code: input.code?.trim() || null, active: input.active ?? true };
  const department = input.id
    ? await prisma.department.update({ where: { id: input.id }, data })
    : await prisma.department.create({ data: { ...data, organizationId: ctx.organizationId! } });

  await writeAudit(ctx, {
    action: input.id ? "department.updated" : "department.created",
    entityType: "Department",
    entityId: department.id,
    after: data,
  });

  return department;
}

/* ------------------------------ designations ------------------------------ */

/**
 * The designation graph.
 *
 * Two separate ideas that `level` was being asked to carry alone. `level` is a
 * presentation band -- it decides the order the list is shown in, and nothing
 * else. The **edges** in `DesignationReporting` are the routing source of
 * truth: they are what says a Software Engineer reports to an Engineering
 * Manager, and they are what suggests a new hire's manager.
 *
 * The table has existed since the schema was written and had never been
 * written to. It did not even have a foreign key.
 */

/** How deep the graph may be walked. Matches `teamEmployeeIds`, deliberately. */
const MAX_GRAPH_DEPTH = 6;

/**
 * Reorders the whole list at once.
 *
 * The complete set, not a subset: renumbering half a list silently reorders
 * the other half against the remaining values. One audit row carrying the
 * before and after, rather than N rows nobody can read as a single change.
 */
export async function reorderDesignations(ctx: AuthContext, orderedIds: string[]) {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");

  const existing = await prisma.designation.findMany({
    where: { organizationId: ctx.organizationId! },
    select: { id: true, title: true, level: true },
    orderBy: [{ level: "asc" }, { title: "asc" }],
  });

  const known = new Set(existing.map((d) => d.id));
  const seen = new Set(orderedIds);
  if (orderedIds.length !== existing.length || orderedIds.some((id) => !known.has(id)) || seen.size !== orderedIds.length) {
    throw new ValidationError("Send the whole list of designations, once each, in the new order.");
  }

  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.designation.update({ where: { id }, data: { level: index } }),
    ),
  );

  await writeAudit(ctx, {
    action: "designation.reordered",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    before: { order: existing.map((d) => d.title) },
    after: {
      order: orderedIds.map((id) => existing.find((d) => d.id === id)?.title ?? id),
    },
  });

  return { reordered: orderedIds.length };
}

/**
 * Whether following `reportsTo` edges upward from `startId` reaches `target`.
 *
 * The whole tenant's edges are loaded once and walked in memory. A graph this
 * size is a few dozen rows, and doing it per hop is a query per level for a
 * check that runs on every edit.
 */
async function designationReaches(
  ctx: AuthContext,
  startId: string,
  target: string,
): Promise<boolean> {
  const edges = await prisma.designationReporting.findMany({
    where: { organizationId: ctx.organizationId! },
    select: { designationId: true, reportsToDesignationId: true },
  });

  const up = new Map<string, string[]>();
  for (const e of edges) {
    up.set(e.designationId, [...(up.get(e.designationId) ?? []), e.reportsToDesignationId]);
  }

  const seen = new Set<string>([startId]);
  let frontier = [startId];
  for (let depth = 0; depth < MAX_GRAPH_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const parent of up.get(id) ?? []) {
        if (parent === target) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return false;
}

export async function setDesignationReporting(
  ctx: AuthContext,
  input: { designationId: string; reportsToDesignationId: string; type?: "PRIMARY" | "SECONDARY" },
) {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");

  if (input.designationId === input.reportsToDesignationId) {
    throw new ValidationError("A designation cannot report to itself.");
  }

  const [from, to] = await Promise.all([
    prisma.designation.findFirst({
      where: { id: input.designationId, organizationId: ctx.organizationId! },
      select: { id: true, title: true },
    }),
    prisma.designation.findFirst({
      where: { id: input.reportsToDesignationId, organizationId: ctx.organizationId! },
      select: { id: true, title: true },
    }),
  ]);
  if (!from || !to) throw new NotFoundError("That designation");

  // Capped at the same depth `teamEmployeeIds` walks: a chart describing a
  // chain deeper than the employee walker will follow is a mismatch nobody
  // sees until somebody's manager stops seeing them.
  if (await designationReaches(ctx, to.id, from.id)) {
    throw new ConflictError(
      `${to.title} already reports to ${from.title}, directly or through somebody else.`,
    );
  }

  const type = input.type ?? "PRIMARY";
  const edge = await prisma.designationReporting.upsert({
    where: {
      designationId_reportsToDesignationId_type: {
        designationId: from.id,
        reportsToDesignationId: to.id,
        type,
      },
    },
    create: {
      organizationId: ctx.organizationId!,
      designationId: from.id,
      reportsToDesignationId: to.id,
      type,
    },
    update: {},
  });

  await writeAudit(ctx, {
    action: "designation.reporting_changed",
    entityType: "DesignationReporting",
    entityId: edge.id,
    after: { designation: from.title, reportsTo: to.title, type },
  });

  return edge;
}

/**
 * Removes an edge.
 *
 * Genuinely a delete, unlike a reporting *line*: an edge in a template carries
 * no history. Nobody's past approval hangs off it.
 */
export async function removeDesignationReporting(
  ctx: AuthContext,
  input: { designationId: string; reportsToDesignationId: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");

  const result = await prisma.designationReporting.deleteMany({
    where: {
      organizationId: ctx.organizationId!,
      designationId: input.designationId,
      reportsToDesignationId: input.reportsToDesignationId,
    },
  });
  if (result.count === 0) throw new NotFoundError("That reporting line");

  await writeAudit(ctx, {
    action: "designation.reporting_changed",
    entityType: "Designation",
    entityId: input.designationId,
    after: { removed: input.reportsToDesignationId },
  });

  return { removed: result.count };
}

export async function saveDesignation(
  ctx: AuthContext,
  input: { id?: string; title: string; level?: number; active?: boolean },
) {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");

  const title = input.title.trim();
  if (title.length < 2) throw new ValidationError("Give the designation a title.");

  // The title is unique per organisation, and the department above says so
  // before it writes. This did not, so "Manager" typed a second time -- or an
  // inline rename onto a title already in the list -- hit the index and came
  // back as "something went wrong on our side" with a reference to quote.
  const clash = await prisma.designation.findFirst({
    where: { organizationId: ctx.organizationId!, title, ...(input.id ? { NOT: { id: input.id } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`There is already a designation called ${title}.`);

  if (input.id) {
    const existing = await prisma.designation.findUnique({ where: { id: input.id } });
    assertSameTenant(ctx, existing, "That designation");
  }

  const data = { title, level: input.level ?? 0, active: input.active ?? true };
  const write = input.id
    ? prisma.designation.update({ where: { id: input.id }, data })
    : prisma.designation.create({ data: { ...data, organizationId: ctx.organizationId! } });
  const designation = await write.catch((error: unknown) => {
    // Two people adding the same title at once get past the check above; the
    // index still refuses the second, and they should hear the same sentence.
    if (isUniqueViolation(error, "title")) {
      throw new ConflictError(`There is already a designation called ${title}.`);
    }
    throw error;
  });

  await writeAudit(ctx, {
    action: input.id ? "designation.updated" : "designation.created",
    entityType: "Designation",
    entityId: designation.id,
    after: data,
  });

  return designation;
}

/* ----------------------------- work locations ----------------------------- */

export interface WorkLocationInput {
  id?: string;
  name: string;
  address?: string;
  addressLine2?: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  requireGps?: boolean;
  requireSelfie?: boolean;
  active?: boolean;
  /** Mark this the branch a new employee joins by default. */
  isPrimary?: boolean;
}

export async function saveWorkLocation(ctx: AuthContext, input: WorkLocationInput) {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the location a name.");

  // Null Island and anything off the globe. A geofence centred on a coordinate
  // nobody meant is worse than none, because it silently refuses everybody or
  // accepts everybody depending on which way it is wrong.
  if (!Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90) {
    throw new ValidationError("That latitude is not a real place.");
  }
  if (!Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180) {
    throw new ValidationError("That longitude is not a real place.");
  }
  if (Math.abs(input.latitude) < 0.0001 && Math.abs(input.longitude) < 0.0001) {
    throw new ValidationError(
      "That is the middle of the Atlantic. Paste the coordinates from a map pin at the office.",
    );
  }
  if (!(input.radiusMeters >= 20 && input.radiusMeters <= 5000)) {
    throw new ValidationError(
      "A radius between 20 m and 5 km. Below that, ordinary GPS drift refuses people who are standing inside.",
    );
  }

  const clash = await prisma.workLocation.findFirst({
    where: { organizationId: ctx.organizationId!, name, ...(input.id ? { NOT: { id: input.id } } : {}) },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`There is already a location called ${name}.`);

  if (input.id) {
    const existing = await prisma.workLocation.findUnique({ where: { id: input.id } });
    assertSameTenant(ctx, existing, "That work location");

    // A device standing here would have nowhere to report from.
    if (input.active === false) {
      const kiosks = await prisma.kioskDevice.count({
        where: { workLocationId: input.id, revokedAt: null },
      });
      if (kiosks > 0) {
        throw new ConflictError(
          `An office device still stands at ${name}. Move or revoke it before switching this location off.`,
        );
      }
    }
  }

  const data = {
    name,
    address: input.address?.trim() || null,
    addressLine2: input.addressLine2?.trim() || null,
    latitude: input.latitude,
    longitude: input.longitude,
    radiusMeters: input.radiusMeters,
    requireGps: input.requireGps ?? true,
    requireSelfie: input.requireSelfie ?? true,
    active: input.active ?? true,
  };

  // A branch that has just been switched off cannot be the one new employees
  // join, and marking one primary unmarks the others. Both in the same
  // transaction as the write, because an organisation with two primaries -- or
  // with a closed one -- is the shape of bug this product already had once, in
  // `OrgPolicyVersion`, where publishing never retired the previous row.
  const wantsPrimary = input.isPrimary === true && data.active;

  const location = await prisma.$transaction(async (tx) => {
    const saved = input.id
      ? await tx.workLocation.update({ where: { id: input.id }, data })
      : await tx.workLocation.create({ data: { ...data, organizationId: ctx.organizationId! } });

    if (input.isPrimary !== undefined) {
      await tx.workLocation.update({
        where: { id: saved.id },
        data: { isPrimary: wantsPrimary },
      });
      if (wantsPrimary) {
        await tx.workLocation.updateMany({
          where: {
            organizationId: ctx.organizationId!,
            isPrimary: true,
            NOT: { id: saved.id },
          },
          data: { isPrimary: false },
        });
      }
      return { ...saved, isPrimary: wantsPrimary };
    }

    // Switching a branch off must not leave it as the default.
    if (!data.active && saved.isPrimary) {
      await tx.workLocation.update({ where: { id: saved.id }, data: { isPrimary: false } });
      return { ...saved, isPrimary: false };
    }

    return saved;
  });

  await writeAudit(ctx, {
    action: input.id ? "worklocation.updated" : "worklocation.created",
    entityType: "WorkLocation",
    entityId: location.id,
    after: { ...data, isPrimary: location.isPrimary },
  });

  return location;
}

/**
 * Copying one branch's attendance rules onto others.
 *
 * The rules and the identity are deliberately separated. `radiusMeters`,
 * `requireGps` and `requireSelfie` are policy -- the same answer usually
 * belongs at every branch, and typing it four times is four chances to type it
 * differently. The name, the address, the coordinates and `isPrimary` are what
 * make a location *that* location, and copying them would produce two branches
 * claiming the same pin.
 *
 * Asked for as "ek location ka setting doosre location me import karne ka
 * feature", after four settings had been entered by hand.
 */
export interface CopyLocationRulesInput {
  fromId: string;
  toIds: string[];
}

export async function copyWorkLocationRules(
  ctx: AuthContext,
  input: CopyLocationRulesInput,
): Promise<{ copied: number; from: string; rules: { radiusMeters: number; requireGps: boolean; requireSelfie: boolean } }> {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");

  const source = await prisma.workLocation.findFirst({
    where: { id: input.fromId, organizationId: ctx.organizationId! },
    select: { id: true, name: true, radiusMeters: true, requireGps: true, requireSelfie: true },
  });
  if (!source) throw new NotFoundError("That work location");

  // Its own id in the list is a no-op an administrator can produce by clicking
  // quickly, not an error worth stopping for.
  const targets = input.toIds.filter((id) => id !== source.id);
  if (targets.length === 0) {
    throw new ValidationError("Choose at least one other branch to copy these rules to.");
  }

  const rules = {
    radiusMeters: source.radiusMeters,
    requireGps: source.requireGps,
    requireSelfie: source.requireSelfie,
  };

  // `updateMany` with the tenant in the predicate, so an id from another
  // organisation matches nothing rather than being written to.
  const result = await prisma.workLocation.updateMany({
    where: { id: { in: targets }, organizationId: ctx.organizationId! },
    data: rules,
  });

  await writeAudit(ctx, {
    action: "worklocation.updated",
    entityType: "WorkLocation",
    entityId: source.id,
    after: { copiedFrom: source.name, to: targets.length, ...rules },
  });

  return { copied: result.count, from: source.name, rules };
}

/* ---------------------------- reporting lines ----------------------------- */

export interface ReportingLine {
  id: string;
  employee: { id: string; name: string; employeeCode: string };
  manager: { id: string; name: string; employeeCode: string };
  type: string;
  /// Null on rows created before the product recorded one.
  startDate: Date | null;
  endDate: Date | null;
}

export async function listReportingLines(ctx: AuthContext): Promise<ReportingLine[]> {
  requireOrg(ctx);

  const rows = await prisma.reportingRelationship.findMany({
    where: { organizationId: ctx.organizationId! },
    select: {
      id: true,
      type: true,
      startDate: true,
      endDate: true,
      employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
      manager: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
    },
    orderBy: [{ endDate: "asc" }, { startDate: "desc" }],
  });

  const name = (e: { firstName: string; lastName: string | null }) =>
    [e.firstName, e.lastName].filter(Boolean).join(" ");

  return rows.map((r) => ({
    id: r.id,
    employee: { id: r.employee.id, name: name(r.employee), employeeCode: r.employee.employeeCode },
    manager: { id: r.manager.id, name: name(r.manager), employeeCode: r.manager.employeeCode },
    type: r.type,
    startDate: r.startDate,
    endDate: r.endDate,
  }));
}

/**
 * The PRIMARY line somebody has now -- the one row with no end date, which the
 * partial index keeps unique. Null when they report to nobody.
 *
 * Every question of the form "who is their manager today" comes through here:
 * the profile seeding its edit dialog, `updateEmployee` deciding whether a
 * manager change is a change, `attachReportingLine` refusing a line that
 * starts before the one it replaces. Each used to carry its own copy of the
 * where-clause, and the dialog opening on a different manager from the one
 * the save compares against is exactly how a phone-number fix reassigned
 * somebody.
 *
 * `requireOrg` only: this reads a fact `getEmployee` already shows anybody who
 * may see the record, and both callers that write have checked their own
 * permission before asking.
 */
export async function livePrimaryLine(ctx: AuthContext, employeeId: string) {
  requireOrg(ctx);

  return prisma.reportingRelationship.findFirst({
    where: { organizationId: ctx.organizationId!, employeeId, ...LIVE_PRIMARY_LINE },
    select: { id: true, managerId: true, startDate: true },
  });
}

/**
 * Who reports to whom.
 *
 * `endDate` carries a contract the whole product depends on: `null` or a future
 * date means the line is live, and `teamEmployeeIds` walks exactly those to
 * resolve every `.team` scope — leave approvals, visible employees, and now the
 * kiosk's PIN issuing. Ending a line is therefore a date, never a delete: a
 * manager who approved leave last March must still be the manager who approved
 * it.
 */
export async function setReportingLine(
  ctx: AuthContext,
  input: { employeeId: string; managerId: string; type?: "PRIMARY" | "SECONDARY"; startDate: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");
  return attachReportingLine(ctx, input);
}

/**
 * The mechanics, with no permission check of its own.
 *
 * `setReportingLine` requires `org.structure.manage`, which is ADMIN and above,
 * while adding an employee requires `employee.create`, which an HR Manager
 * holds. Without this split an HR Manager adding somebody with a manager would
 * be refused halfway through -- after the employee row, before the reporting
 * line. The caller supplies the authorisation; both callers do.
 */
export async function attachReportingLine(
  ctx: AuthContext,
  input: { employeeId: string; managerId: string; type?: "PRIMARY" | "SECONDARY"; startDate: string },
) {
  requireOrg(ctx);

  if (input.employeeId === input.managerId) {
    throw new ValidationError("Somebody cannot report to themselves.");
  }

  const [employee, manager] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: input.employeeId, organizationId: ctx.organizationId! },
      select: { id: true, firstName: true },
    }),
    prisma.employee.findFirst({
      where: { id: input.managerId, organizationId: ctx.organizationId! },
      select: { id: true, firstName: true },
    }),
  ]);
  if (!employee || !manager) throw new NotFoundError("That employee");

  const type = input.type ?? "PRIMARY";
  const startDate = new Date(`${input.startDate}T00:00:00.000Z`);

  // A cycle would make `teamEmployeeIds` walk for ever — it is bounded at six
  // levels, so it would not hang, but a manager appearing inside their own team
  // is nonsense that shows up as a permissions oddity months later.
  if (await reportsTo(ctx, input.managerId, input.employeeId)) {
    throw new ConflictError(
      `${manager.firstName} already reports to ${employee.firstName}, directly or through somebody else.`,
    );
  }

  // A new line cannot start on or before the one it replaces, or closing the
  // old one writes a zero-length or negative span.
  if (type === "PRIMARY") {
    const current = await livePrimaryLine(ctx, employee.id);
    if (current?.startDate && current.startDate >= startDate) {
      throw new ValidationError(
        "A new reporting line has to start after the one it replaces.",
      );
    }
  }

  const line = await prisma.$transaction(async (tx) => {
    // One live primary line at a time. The previous one is ended the day this
    // starts rather than removed.
    if (type === "PRIMARY") {
      await tx.reportingRelationship.updateMany({
        where: {
          organizationId: ctx.organizationId!,
          employeeId: employee.id,
          type: "PRIMARY",
          OR: [{ endDate: null }, { endDate: { gt: startDate } }],
        },
        data: { endDate: startDate },
      });
    }

    // Always a new row. This used to upsert on
    // `@@unique([employeeId, managerId, type])`, so re-appointing a previous
    // manager reopened the closed row -- collapsing "managed Jan to March, then
    // again from September" into "since September", and taking the manager off
    // the approval they gave in March. The constraint is gone; what stays
    // unique is one live PRIMARY line, enforced by a partial index.
    return tx.reportingRelationship.create({
      data: {
        organizationId: ctx.organizationId!,
        employeeId: employee.id,
        managerId: manager.id,
        type,
        startDate,
      },
    });
  });

  await writeAudit(ctx, {
    action: "reporting.changed",
    entityType: "ReportingRelationship",
    entityId: line.id,
    after: { employeeId: employee.id, managerId: manager.id, type, startDate: input.startDate },
  });

  return line;
}

export async function endReportingLine(ctx: AuthContext, lineId: string, endDate: string) {
  requireOrg(ctx);
  requireWrite(ctx, "org.structure.manage");

  const line = await prisma.reportingRelationship.findUnique({ where: { id: lineId } });
  assertSameTenant(ctx, line, "That reporting line");

  const ends = new Date(`${endDate}T00:00:00.000Z`);
  // Rows created before the product recorded a start date have none, and there
  // is nothing to compare against.
  if (line!.startDate && ends < line!.startDate) {
    throw new ValidationError("A reporting line cannot end before it started.");
  }

  const updated = await prisma.reportingRelationship.update({
    where: { id: lineId },
    data: { endDate: ends },
  });

  await writeAudit(ctx, {
    action: "reporting.changed",
    entityType: "ReportingRelationship",
    entityId: lineId,
    before: { endDate: line!.endDate },
    after: { endDate: ends },
  });

  return updated;
}

/** Walks up the live reporting lines, so a cycle can be refused before it exists. */
async function reportsTo(ctx: AuthContext, employeeId: string, possibleReport: string): Promise<boolean> {
  const live = liveReportingWhere(ctx.organization?.timezone ?? "Asia/Kolkata");
  let frontier = [employeeId];
  const seen = new Set(frontier);

  for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
    const lines = await prisma.reportingRelationship.findMany({
      where: {
        organizationId: ctx.organizationId!,
        employeeId: { in: frontier },
        ...live,
      },
      select: { managerId: true },
    });

    const next: string[] = [];
    for (const line of lines) {
      if (line.managerId === possibleReport) return true;
      if (!seen.has(line.managerId)) {
        seen.add(line.managerId);
        next.push(line.managerId);
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * Put a group of employees on one branch, in a single write.
 *
 * This exists because of a number: on production, every employee in every
 * organisation had `workLocationId = NULL`, and the geofence is only ever
 * evaluated for somebody who has one. Fixing that one profile at a time is
 * eleven screens for a roster of eleven, and the organisations that most need a
 * fence are the ones with the longest rosters.
 *
 * `null` is a real choice here and means "take them off a branch" — an
 * administrator has to be able to undo this, and a function that could only
 * assign would make a mistaken bulk assign permanent.
 */
export async function assignWorkLocation(
  ctx: AuthContext,
  input: { employeeIds: string[]; workLocationId: string | null },
): Promise<{ updated: number }> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.update");

  const ids = [...new Set(input.employeeIds.filter(Boolean))];
  if (ids.length === 0) throw new ValidationError("Choose at least one person.");

  let locationName: string | null = null;
  if (input.workLocationId) {
    const location = await prisma.workLocation.findUnique({
      where: { id: input.workLocationId },
      select: { id: true, name: true, active: true, organizationId: true },
    });
    assertSameTenant(ctx, location, "That work location");
    if (!location!.active) {
      // Assigning onto a closed branch reads as a fix and is not one: the
      // server refuses to measure against an inactive location, so everybody
      // moved there would still be marking from anywhere.
      throw new ValidationError(
        `${location!.name} is switched off, so attendance there would not be checked against it. Switch it back on first.`,
      );
    }
    locationName = location!.name;
  }

  // Scoped to this organisation in the `where`, not merely checked beforehand:
  // an id belonging to another tenant simply matches nothing rather than being
  // updated, which is the same shape every other bulk write here uses.
  const result = await prisma.employee.updateMany({
    where: { id: { in: ids }, organizationId: ctx.organizationId! },
    data: { workLocationId: input.workLocationId },
  });

  await writeAudit(ctx, {
    action: "worklocation.assigned",
    entityType: "WorkLocation",
    entityId: input.workLocationId ?? undefined,
    after: {
      workLocation: locationName,
      // The count, and the codes, so this is answerable later without joining
      // against rows that may since have moved again.
      people: result.count,
      requested: ids.length,
    },
  });

  return { updated: result.count };
}
