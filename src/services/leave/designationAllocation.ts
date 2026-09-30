import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";

/**
 * How many days of each leave type a designation gets.
 *
 * `LeaveType.annualAllocation` is one number for the whole company, which is not
 * how leave works anywhere — a manager and a trainee do not get the same casual
 * leave, and writing that once per role rather than once per person is the
 * difference between a policy somebody maintains and one they abandon.
 *
 * A designation with no row here follows the type's own number. Removing a row
 * is how you go back to that, which is why there is no third "same as the
 * company" value: a row that only repeats its parent is a row somebody has to
 * keep in step by hand, and will not.
 *
 * `LeaveBalance.allocated` stays below this as the finest layer — the one person
 * whose contract says something different — and is untouched.
 *
 * The on-demand week off (`LeaveType.isWeekOff`) is not a column here. It is
 * a bank of extra rest days handed to one person on the balance grid, and a
 * role-wide figure for it sat beside "week offs a month" as a second number
 * with the same name — the paid quota — that meant something else entirely.
 * One week-off number per role, and it is the quota.
 */

export interface DesignationAllocationView {
  types: { id: string; code: string; name: string; annualAllocation: number }[];
  /**
   * `weekOffsPerMonth` is the paid quota for the role: null where the role
   * follows the payroll rule, which is itself allowed to mean "whatever the
   * weekly-off pattern gives". A person's own `Employee.weekOffsPerMonth` sits
   * above this and is set on their profile, not here — the same shape leave
   * allocation already has, person, then role, then the company.
   */
  designations: { id: string; title: string; weekOffsPerMonth: number | null }[];
  /** Only where somebody has set one. `leaveTypeId:designationId -> days`. */
  overrides: Record<string, number>;
}

const key = (leaveTypeId: string, designationId: string) => `${leaveTypeId}:${designationId}`;

export async function getDesignationAllocations(
  ctx: AuthContext,
): Promise<DesignationAllocationView> {
  requireOrg(ctx);
  requirePermission(ctx, "leave.balance.manage");

  const [types, designations, rows] = await Promise.all([
    prisma.leaveType.findMany({
      where: { organizationId: ctx.organizationId!, active: true, isWeekOff: false },
      select: { id: true, code: true, name: true, annualAllocation: true },
      orderBy: { code: "asc" },
    }),
    prisma.designation.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      select: { id: true, title: true, weekOffsPerMonth: true },
      orderBy: { level: "asc" },
    }),
    prisma.designationLeaveAllocation.findMany({
      where: { organizationId: ctx.organizationId! },
      select: { leaveTypeId: true, designationId: true, annualAllocation: true },
    }),
  ]);

  return {
    types: types.map((t) => ({ ...t, annualAllocation: Number(t.annualAllocation) })),
    designations,
    overrides: Object.fromEntries(
      rows.map((r) => [key(r.leaveTypeId, r.designationId), Number(r.annualAllocation)]),
    ),
  };
}

/**
 * Week offs a month for one role.
 *
 * Beside the leave grid rather than on the payroll rules screen, because it is
 * the same question asked per role — "what does this job get" — and the person
 * answering it is looking at one table, not two screens.
 */
export async function setDesignationWeekOffs(
  ctx: AuthContext,
  input: { designationId: string; weekOffsPerMonth: number | null },
): Promise<DesignationAllocationView> {
  requireOrg(ctx);
  requireWrite(ctx, "leave.balance.manage", "leave");

  const designation = await prisma.designation.findFirst({
    where: { id: input.designationId, organizationId: ctx.organizationId! },
    select: { id: true, title: true, weekOffsPerMonth: true },
  });
  if (!designation) throw new NotFoundError("That designation");

  if (input.weekOffsPerMonth !== null) {
    if (
      !Number.isInteger(input.weekOffsPerMonth) ||
      input.weekOffsPerMonth < 0 ||
      input.weekOffsPerMonth > 31
    ) {
      throw new ValidationError("Week offs a month is a whole number between 0 and 31.");
    }
  }

  await prisma.designation.updateMany({
    where: { id: input.designationId, organizationId: ctx.organizationId! },
    data: { weekOffsPerMonth: input.weekOffsPerMonth },
  });

  await writeAudit(ctx, {
    action: "leave.balance_adjusted",
    entityType: "Designation",
    entityId: input.designationId,
    before: { weekOffsPerMonth: designation.weekOffsPerMonth },
    after: { weekOffsPerMonth: input.weekOffsPerMonth },
  });

  return getDesignationAllocations(ctx);
}

export async function setDesignationAllocation(
  ctx: AuthContext,
  input: {
    leaveTypeId: string;
    designationId: string;
    /** `null` removes the override and follows the leave type again. */
    days: number | null;
  },
): Promise<DesignationAllocationView> {
  requireOrg(ctx);
  requireWrite(ctx, "leave.balance.manage", "leave");

  // Both tenant-checked before anything is written: an id from another
  // organisation must never become a row in this one.
  const [type, designation] = await Promise.all([
    prisma.leaveType.findFirst({
      where: { id: input.leaveTypeId, organizationId: ctx.organizationId! },
      select: { id: true, code: true, isWeekOff: true },
    }),
    prisma.designation.findFirst({
      where: { id: input.designationId, organizationId: ctx.organizationId! },
      select: { id: true, title: true },
    }),
  ]);
  if (!type) throw new NotFoundError("That leave type");
  if (!designation) throw new NotFoundError("That designation");
  // Refused rather than hidden: the grid does not show this column, and a row
  // the route still accepted would be a figure nobody can see. Clearing one
  // (`days: null`) is still allowed, so a row from before the column went
  // stays removable.
  if (type.isWeekOff && input.days !== null) {
    throw new ValidationError(
      "The on-demand week off is allocated per person on the balance grid, not by designation. Week offs a month for a role is the paid quota column.",
    );
  }

  if (input.days !== null) {
    // A year is 365 days and nobody is allocated more; beyond that somebody has
    // typed hours, or a salary, into a day count.
    if (!Number.isFinite(input.days) || input.days < 0 || input.days > 365) {
      throw new ValidationError("An allocation is between 0 and 365 days.");
    }
  }

  if (input.days === null) {
    await prisma.designationLeaveAllocation.deleteMany({
      where: { designationId: input.designationId, leaveTypeId: input.leaveTypeId },
    });
  } else {
    await prisma.designationLeaveAllocation.upsert({
      where: {
        designationId_leaveTypeId: {
          designationId: input.designationId,
          leaveTypeId: input.leaveTypeId,
        },
      },
      create: {
        organizationId: ctx.organizationId!,
        designationId: input.designationId,
        leaveTypeId: input.leaveTypeId,
        annualAllocation: input.days,
        updatedById: ctx.userId,
      },
      update: { annualAllocation: input.days, updatedById: ctx.userId },
    });
  }

  await writeAudit(ctx, {
    action: "leave.balance_adjusted",
    entityType: "Designation",
    entityId: input.designationId,
    after: { leaveType: type.code, days: input.days },
  });

  return getDesignationAllocations(ctx);
}
