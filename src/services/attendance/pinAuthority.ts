import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { hasPermission, requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ROLE_LABELS, type SystemRole } from "@/lib/auth/permissions";
import type { Prisma } from "@prisma/client";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { employeeName } from "@/domain/employees/name";

/**
 * Who may hand out an attendance PIN.
 *
 * A PIN is the only way past a face check that will not pass — a scar, a new
 * beard, a phone camera that cannot see in a dark corridor — so deciding who
 * issues them is a real access decision. It used to have no answer an
 * administrator could see or change: `issueAttendancePin` fell back to
 * `attendance.override` or to being somebody's reporting manager, both buried
 * in code.
 *
 * Two levels, the same shape as the module controls: name a **designation** and
 * everybody holding it may issue, or name **one person**. Rows only ever grant.
 * Taking authority away removes the row rather than adding a second row that
 * contradicts the first, which is the design mistake that makes permission
 * systems impossible to reason about.
 *
 * Three levels now: a login **role** ("every HR manager"), a **designation**
 * ("every Shift Supervisor"), or **one person**. Owner and Admin hold
 * `attendance.pin.issue` from the role bundle and are never rows. Rows only
 * ever grant. Taking authority away removes the row rather than adding a
 * second row that contradicts the first, which is the design mistake that
 * makes permission systems impossible to reason about.
 */

export interface PinAuthorityRow {
  id: string;
  kind: "DESIGNATION" | "EMPLOYEE";
  /** A designation title, or a person's name. */
  label: string;
  /** For a person, their code, so two of the same name can be told apart. */
  detail: string | null;
  targetId: string;
}

/** One login role and whether it may issue: the checkbox row on the screen. */
export interface PinAuthorityRole {
  role: SystemRole;
  label: string;
  granted: boolean;
  /** Owner and Admin: on from the role bundle, and not a row anybody can remove. */
  always: boolean;
  /** The row to delete to switch it off, when it is a row. */
  rowId: string | null;
}

export interface PinAuthorityView {
  roles: PinAuthorityRole[];
  rows: PinAuthorityRow[];
  designations: { id: string; title: string }[];
  employees: { id: string; name: string; code: string; designation: string | null }[];
}

/**
 * The roles the owner can tick.
 *
 * Owner and Admin are on and locked: `attendance.pin.issue` is in the Admin
 * bundle, so a row for either would say nothing. The device role is never
 * offered -- a shared screen issuing its own bypass is the door this whole
 * feature exists to close. Order is seniority, the way every role list reads.
 */
const GRANTABLE_ROLES: SystemRole[] = ["HR_MANAGER", "MANAGER", "TEAM_LEAD", "SUPERVISOR", "TEAM_MEMBER"];
const ALWAYS_ROLES: SystemRole[] = ["ORG_OWNER", "ADMIN"];

function activeEmployeeFilter(organizationId: string): Prisma.EmployeeWhereInput {
  return {
    organizationId,
    active: true,
    employmentState: { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] },
  };
}

export async function getPinAuthorities(ctx: AuthContext): Promise<PinAuthorityView> {
  requireOrg(ctx);
  // A read, for whoever may open the settings screen. The panel showed
  // "Loading..." for ever to an HR manager and to every lapsed organisation
  // because this asked for the write permission and writability.
  requirePermission(ctx, "org.settings.read");

  const [rows, designations, employees] = await Promise.all([
    prisma.attendancePinAuthority.findMany({
      where: { organizationId: ctx.organizationId! },
      select: {
        id: true,
        role: true,
        designation: { select: { id: true, title: true } },
        employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.designation.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      select: { id: true, title: true },
      orderBy: { level: "asc" },
    }),
    prisma.employee.findMany({
      where: activeEmployeeFilter(ctx.organizationId!),
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeCode: true,
        designation: { select: { title: true } },
      },
      orderBy: { employeeCode: "asc" },
    }),
  ]);

  const roleRows = new Map(rows.flatMap((r) => (r.role ? [[r.role, r.id] as const] : [])));

  return {
    roles: [
      ...ALWAYS_ROLES.map((role) => ({
        role,
        label: ROLE_LABELS[role],
        granted: true,
        always: true,
        rowId: null,
      })),
      ...GRANTABLE_ROLES.map((role) => ({
        role,
        label: ROLE_LABELS[role],
        granted: roleRows.has(role),
        always: false,
        rowId: roleRows.get(role) ?? null,
      })),
    ],
    rows: rows.flatMap((row): PinAuthorityRow[] => {
      if (row.designation) {
        return [
          {
            id: row.id,
            kind: "DESIGNATION",
            label: row.designation.title,
            detail: null,
            targetId: row.designation.id,
          },
        ];
      }
      if (row.employee) {
        return [
          {
            id: row.id,
            kind: "EMPLOYEE",
            label: employeeName(row.employee),
            detail: row.employee.employeeCode,
            targetId: row.employee.id,
          },
        ];
      }
      // A role row is rendered as a checkbox above, not as a list entry; a row
      // with none of the three resolved is not shown and not crashed on.
      return [];
    }),
    designations,
    employees: employees.map((e) => ({
      id: e.id,
      name: employeeName(e),
      code: e.employeeCode,
      designation: e.designation?.title ?? null,
    })),
  };
}

export async function grantPinAuthority(
  ctx: AuthContext,
  input: { designationId?: string | null; employeeId?: string | null; role?: SystemRole | null },
): Promise<void> {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.settings.manage");

  const designationId = input.designationId || null;
  const employeeId = input.employeeId || null;
  const role = input.role || null;
  if ([designationId, employeeId, role].filter(Boolean).length !== 1) {
    throw new ValidationError("Choose a role, a designation, or one person.");
  }

  // Tenant-checked before anything is written: an id from another organisation
  // must never become a row in this one.
  if (designationId) {
    const found = await prisma.designation.findFirst({
      where: { id: designationId, organizationId: ctx.organizationId! },
      select: { id: true },
    });
    if (!found) throw new NotFoundError("That designation");
  } else if (employeeId) {
    const found = await prisma.employee.findFirst({
      where: { id: employeeId, organizationId: ctx.organizationId! },
      select: { id: true },
    });
    if (!found) throw new NotFoundError("That employee");
  } else if (role && !GRANTABLE_ROLES.includes(role)) {
    throw new ValidationError(
      ALWAYS_ROLES.includes(role)
        ? `${ROLE_LABELS[role]}s can always issue a PIN.`
        : "That role cannot be given this.",
    );
  }

  // Idempotent: granting twice is what a double tap looks like, not an error.
  await prisma.attendancePinAuthority.upsert({
    where: designationId
      ? { organizationId_designationId: { organizationId: ctx.organizationId!, designationId } }
      : employeeId
        ? {
            organizationId_employeeId: {
              organizationId: ctx.organizationId!,
              employeeId,
            },
          }
        : { organizationId_role: { organizationId: ctx.organizationId!, role: role! } },
    create: {
      organizationId: ctx.organizationId!,
      designationId,
      employeeId,
      role,
      createdById: ctx.userId,
    },
    update: {},
  });

  await writeAudit(ctx, {
    action: "attendance.pin_authority.granted",
    entityType: designationId ? "Designation" : employeeId ? "Employee" : "Role",
    entityId: designationId ?? employeeId ?? role!,
  });
}

export async function revokePinAuthority(ctx: AuthContext, id: string): Promise<void> {
  requireOrg(ctx);
  requireWrite(ctx, "attendance.settings.manage");

  const row = await prisma.attendancePinAuthority.findFirst({
    where: { id, organizationId: ctx.organizationId! },
    select: { id: true, designationId: true, employeeId: true, role: true },
  });
  if (!row) throw new NotFoundError("That authority");

  await prisma.attendancePinAuthority.delete({ where: { id: row.id } });

  await writeAudit(ctx, {
    action: "attendance.pin_authority.revoked",
    entityType: row.designationId ? "Designation" : row.employeeId ? "Employee" : "Role",
    entityId: row.designationId ?? row.employeeId ?? row.role ?? row.id,
  });
}

/**
 * Whether this actor may issue a PIN at all.
 *
 * One permission, `attendance.pin.issue`. Owner and Admin hold it from the role
 * bundle; anybody named on the PIN authority screen -- by role, designation or
 * person -- has it folded into their context when it is loaded. The row is
 * checked here as well, so a context built without the fold still answers
 * correctly; it costs one indexed read.
 *
 * `attendance.override` no longer implies it. The owner's answer, asked
 * directly, was Owner and Admin by default and everybody else by their tick --
 * and correcting a day after the fact is a different power from waving
 * somebody past the camera at the door.
 *
 * Deliberately not "for this employee": an authority is organisation-wide,
 * because the person somebody can physically reach when their face will not
 * scan is whoever is standing in that office. `issueAttendancePin` keeps its
 * own reporting-manager route as well; this only ever adds people.
 */
export async function mayIssuePin(ctx: AuthContext): Promise<boolean> {
  requireOrg(ctx);
  if (hasPermission(ctx, "attendance.pin.issue")) return true;
  if (ctx.role === "KIOSK") return false;

  const me = ctx.employeeId
    ? await prisma.employee.findFirst({
        where: { id: ctx.employeeId, organizationId: ctx.organizationId! },
        select: { id: true, designationId: true },
      })
    : null;

  const row = await prisma.attendancePinAuthority.findFirst({
    where: {
      organizationId: ctx.organizationId!,
      OR: [
        { role: ctx.role },
        ...(me ? [{ employeeId: me.id }] : []),
        ...(me?.designationId ? [{ designationId: me.designationId }] : []),
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Who to ask, by name, for the dialog somebody sees when their face fails.
 *
 * "Ask an administrator" is what the product said before, and in an office of
 * forty that is not an instruction. This names the people who can actually
 * help: everybody who holds the permission -- the owner, the admins, whichever
 * roles were ticked, anybody granted it by hand -- and everybody named by
 * designation or in person. It used to list only the last two, so on every
 * live organisation it said nobody could help while the owner could.
 *
 * Readable by any signed-in member: it is a list of who to go to, which is
 * exactly the sort of thing that is useless if it is secret. Names and
 * designations only -- no contact details and no ids.
 */
export async function whoCanIssuePin(
  ctx: AuthContext,
): Promise<{ name: string; designation: string | null }[]> {
  requireOrg(ctx);

  const rows = await prisma.attendancePinAuthority.findMany({
    where: { organizationId: ctx.organizationId! },
    select: { designationId: true, employeeId: true, role: true },
  });

  const designationIds = rows.flatMap((r) => (r.designationId ? [r.designationId] : []));
  const employeeIds = rows.flatMap((r) => (r.employeeId ? [r.employeeId] : []));
  const roles: SystemRole[] = [...ALWAYS_ROLES, ...rows.flatMap((r) => (r.role ? [r.role] : []))];

  const people = await prisma.employee.findMany({
    where: {
      ...activeEmployeeFilter(ctx.organizationId!),
      OR: [
        ...(employeeIds.length ? [{ id: { in: employeeIds } }] : []),
        ...(designationIds.length ? [{ designationId: { in: designationIds } }] : []),
        // Holders by role, and by a hand grant on the person. A hand revoke
        // takes somebody off the list even when their role is on it.
        {
          user: {
            status: "ACTIVE",
            OR: [
              { role: { in: roles } },
              { permissionGrants: { some: { permission: "attendance.pin.issue", granted: true } } },
            ],
            NOT: { permissionGrants: { some: { permission: "attendance.pin.issue", granted: false } } },
          },
        },
      ],
      // Nobody is told to ask themselves.
      ...(ctx.employeeId ? { NOT: { id: ctx.employeeId } } : {}),
    },
    select: {
      firstName: true,
      lastName: true,
      designation: { select: { title: true } },
    },
    orderBy: [{ firstName: "asc" }],
    take: 20,
  });

  return people.map((p) => ({
    name: employeeName(p),
    designation: p.designation?.title ?? null,
  }));
}

/* -------------------------------------------------------------------------- */
/*  The PIN desk                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everybody a PIN could be issued for, for the desk's own picker.
 *
 * Not `listEmployees`: that scopes through `employee.read`, which a ticked
 * Team Member does not hold, so the picker would show them only themselves.
 * An authority is organisation-wide and so is this list -- name, code and
 * designation, nothing else. The caller is left out: nobody issues their own.
 */
export async function pinRoster(
  ctx: AuthContext,
): Promise<{ id: string; name: string; code: string; designation: string | null }[]> {
  requireOrg(ctx);
  requirePermission(ctx, "attendance.pin.issue");

  const people = await prisma.employee.findMany({
    where: {
      ...activeEmployeeFilter(ctx.organizationId!),
      ...(ctx.employeeId ? { NOT: { id: ctx.employeeId } } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      designation: { select: { title: true } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: 1000,
  });

  return people.map((p) => ({
    id: p.id,
    name: employeeName(p),
    code: p.employeeCode,
    designation: p.designation?.title ?? null,
  }));
}

export interface RecentPin {
  id: string;
  employeeName: string;
  employeeCode: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  reason: string | null;
  issuedByName: string | null;
  state: "LIVE" | "USED" | "EXPIRED";
}

/**
 * The PINs issued in the last day.
 *
 * `AttendancePin` was only ever written and looked up by hash; nothing listed
 * it, so the person who had just read a code out could not see whether it had
 * been used. Somebody who runs the attendance settings sees everybody's;
 * anybody else sees the ones they issued.
 */
export async function listRecentPins(ctx: AuthContext): Promise<RecentPin[]> {
  requireOrg(ctx);
  requirePermission(ctx, "attendance.pin.issue");

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const seesAll = hasPermission(ctx, "attendance.settings.manage");

  const pins = await prisma.attendancePin.findMany({
    where: {
      organizationId: ctx.organizationId!,
      issuedAt: { gte: since },
      ...(seesAll ? {} : { issuedById: ctx.userId }),
    },
    select: {
      id: true,
      issuedAt: true,
      expiresAt: true,
      usedAt: true,
      reason: true,
      issuedById: true,
      employee: { select: { firstName: true, lastName: true, employeeCode: true } },
    },
    orderBy: { issuedAt: "desc" },
    take: 100,
  });

  const issuerIds = [...new Set(pins.map((p) => p.issuedById))];
  const issuers = issuerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: issuerIds } },
        select: { id: true, name: true, email: true },
      })
    : [];

  return pins.map((pin) => {
    const issuer = issuers.find((u) => u.id === pin.issuedById);
    return {
      id: pin.id,
      employeeName: employeeName(pin.employee),
      employeeCode: pin.employee.employeeCode,
      issuedAt: pin.issuedAt,
      expiresAt: pin.expiresAt,
      usedAt: pin.usedAt,
      reason: pin.reason,
      issuedByName: issuer ? (issuer.name ?? issuer.email) : null,
      state: pin.usedAt ? "USED" : pin.expiresAt <= now ? "EXPIRED" : "LIVE",
    };
  });
}
