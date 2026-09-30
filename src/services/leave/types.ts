import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";

/**
 * Leave types, managed.
 *
 * **There was no way to manage them at all.** Five types were written by
 * `provisionTenant` — CL, SL, EL, LWP and COMP_OFF — and no service, no route
 * and no screen ever wrote a `LeaveType` again. So an organisation whose sick
 * leave is ten days rather than eight, or who wants a bereavement type, or who
 * needs one of the five marked unpaid, was stuck with the seed for the life of
 * the tenant. `leave.type.manage` has existed in the permission list since it
 * was written and gated nothing.
 *
 * Two things here are deliberately harder than the rest.
 *
 * **A code is set once.** `LeaveBalance` and `LeaveRequest` key on the id, so a
 * changed code would not corrupt anything — but the code is what appears on the
 * balance grid, in exports, in the payroll trace and in every letter that has
 * already been issued, and renaming it silently rewrites the meaning of records
 * nobody is looking at. A new type is cheap; a renamed one is a lie about the
 * past.
 *
 * **Nothing is deleted.** A type with history behind it cannot go without
 * taking the history with it, so `active: false` is the only retirement. It
 * disappears from the request form and stays on the balances that already
 * mention it.
 */

export interface LeaveTypeRow {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  annualAllocation: number;
  accrualMode: string;
  monthlyAccrual: number;
  carryForward: boolean;
  maxCarryForward: number;
  allowHalfDay: boolean;
  requiresApproval: boolean;
  maxConsecutive: number | null;
  noticeDays: number;
  countsAsPresent: boolean;
  isCompOff: boolean;
  isWeekOff: boolean;
  /** The most days of it one person may take in a month; null is no cap. */
  maxPerMonth: number | null;
  active: boolean;
  color: string;
  /** How many balances and requests already point at it. */
  inUse: number;
}

export interface LeaveTypeInput {
  id?: string;
  code: string;
  name: string;
  paid: boolean;
  annualAllocation: number;
  accrualMode: "ANNUAL" | "MONTHLY" | "NONE";
  monthlyAccrual: number;
  carryForward: boolean;
  maxCarryForward: number;
  allowHalfDay: boolean;
  requiresApproval: boolean;
  maxConsecutive: number | null;
  noticeDays: number;
  countsAsPresent: boolean;
  isWeekOff: boolean;
  maxPerMonth: number | null;
  active: boolean;
}

export async function listLeaveTypesForAdmin(ctx: AuthContext): Promise<LeaveTypeRow[]> {
  requireOrg(ctx);
  requirePermission(ctx, "leave.type.manage");

  const rows = await prisma.leaveType.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: [{ active: "desc" }, { code: "asc" }],
    include: { _count: { select: { balances: true, requests: true } } },
  });

  return rows.map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    paid: t.paid,
    annualAllocation: Number(t.annualAllocation),
    accrualMode: t.accrualMode,
    monthlyAccrual: Number(t.monthlyAccrual),
    carryForward: t.carryForward,
    maxCarryForward: Number(t.maxCarryForward),
    allowHalfDay: t.allowHalfDay,
    requiresApproval: t.requiresApproval,
    maxConsecutive: t.maxConsecutive,
    noticeDays: t.noticeDays,
    countsAsPresent: t.countsAsPresent,
    isCompOff: t.isCompOff,
    isWeekOff: t.isWeekOff,
    maxPerMonth: t.maxPerMonth,
    active: t.active,
    color: t.color,
    inUse: t._count.balances + t._count.requests,
  }));
}

function validate(input: LeaveTypeInput): void {
  if (!input.name.trim()) throw new ValidationError("Give the leave type a name.");
  if (!/^[A-Z0-9_]{2,12}$/.test(input.code)) {
    throw new ValidationError(
      "A code is two to twelve characters, capitals, digits and underscores only.",
    );
  }
  if (input.carryForward && input.maxCarryForward <= 0) {
    // Carry-forward with a cap of zero carries nothing, so the switch would be
    // on and doing nothing — which is worse than being off.
    throw new ValidationError(
      "Carrying days forward needs a cap above zero, or nothing will carry.",
    );
  }
  if (input.accrualMode === "MONTHLY" && input.monthlyAccrual <= 0) {
    throw new ValidationError("Monthly accrual needs a rate above zero.");
  }

  /**
   * A type appears to employees only once somebody has said what it is worth.
   *
   * The five seeded types used to arrive switched on carrying numbers nobody
   * had chosen — twelve casual days, eight sick — and an organisation whose
   * policy is different found out on the day an employee applied for leave they
   * did not have. They arrive off now, and this is what off means: the switch
   * will not move until the frequency and the days are set.
   *
   * `NONE` is exempt and has to be. Leave without pay grants nothing by
   * definition, and a compensatory off is credited by payroll rather than
   * accrued — refusing those would make two legitimate types unswitchable.
   */
  if (input.active && input.accrualMode !== "NONE" && input.annualAllocation <= 0) {
    throw new ValidationError(
      "Set how many days a year this gives before switching it on, or set it to grant days only when payroll credits them.",
    );
  }
}

/**
 * At most one type is the on-demand week off.
 *
 * `isWeekOff` is the marker attendance and payroll read to turn a booked day
 * into a rest day rather than paid leave, and the week-off quota is measured
 * against every such day. Two types carrying it would be two banks of rest
 * days drawing on one quota, and the leave-types screen would have no way to
 * say which of them the "Max a month" figure meant. The retired ones count
 * too: a type that is switched off still marks its history, and the sentence
 * says where the switch is.
 */
async function assertOnlyWeekOff(organizationId: string, input: LeaveTypeInput): Promise<void> {
  if (!input.isWeekOff) return;
  const holder = await prisma.leaveType.findFirst({
    where: {
      organizationId,
      isWeekOff: true,
      ...(input.id ? { id: { not: input.id } } : {}),
    },
    select: { name: true, code: true },
  });
  if (holder) {
    throw new ConflictError(
      `${holder.name} (${holder.code}) is already the on-demand week off; switch that off there before making this one it.`,
    );
  }
}

export async function saveLeaveType(ctx: AuthContext, input: LeaveTypeInput) {
  requireOrg(ctx);
  requireWrite(ctx, "leave.type.manage", "leave");
  validate(input);
  await assertOnlyWeekOff(ctx.organizationId!, input);

  const data = {
    name: input.name.trim(),
    paid: input.paid,
    annualAllocation: input.annualAllocation,
    accrualMode: input.accrualMode,
    monthlyAccrual: input.accrualMode === "MONTHLY" ? input.monthlyAccrual : 0,
    carryForward: input.carryForward,
    maxCarryForward: input.carryForward ? input.maxCarryForward : 0,
    allowHalfDay: input.allowHalfDay,
    requiresApproval: input.requiresApproval,
    maxConsecutive: input.maxConsecutive,
    noticeDays: input.noticeDays,
    // Stored and read by nothing. The form no longer offers it, because a
    // switch labelled "counts as present in attendance reports" that changes
    // no report is the exact defect this round is about. Kept on the row so an
    // existing value is preserved rather than reset to the column default.
    countsAsPresent: input.countsAsPresent,
    // Neither was written by anything until now: the seeded week off was the
    // only type that could ever carry the marker, and the cap did not exist.
    isWeekOff: input.isWeekOff,
    maxPerMonth: input.maxPerMonth,
    active: input.active,
  };

  if (input.id) {
    const existing = await prisma.leaveType.findFirst({
      where: { id: input.id, organizationId: ctx.organizationId },
    });
    if (!existing) throw new NotFoundError("That leave type");

    // The code is not in `data`, on purpose. See the note at the top.
    const updated = await prisma.leaveType.updateMany({
      where: { id: input.id, organizationId: ctx.organizationId },
      data,
    });
    if (updated.count === 0) throw new NotFoundError("That leave type");

    await writeAudit(ctx, {
      action: "leave.type.updated",
      entityType: "LeaveType",
      entityId: input.id,
      before: {
        name: existing.name,
        paid: existing.paid,
        active: existing.active,
        isWeekOff: existing.isWeekOff,
        maxPerMonth: existing.maxPerMonth,
      },
      after: {
        name: data.name,
        paid: data.paid,
        active: data.active,
        isWeekOff: data.isWeekOff,
        maxPerMonth: data.maxPerMonth,
      },
    });
    return { id: input.id, code: existing.code };
  }

  const clash = await prisma.leaveType.findFirst({
    where: { organizationId: ctx.organizationId, code: input.code },
    select: { id: true, active: true },
  });
  if (clash) {
    throw new ConflictError(
      clash.active
        ? `A leave type with the code ${input.code} already exists.`
        : `A retired leave type still holds the code ${input.code}. Switch it back on instead of creating a second one.`,
    );
  }

  const created = await prisma.leaveType.create({
    data: { ...data, code: input.code, organizationId: ctx.organizationId! },
    select: { id: true, code: true },
  });

  await writeAudit(ctx, {
    action: "leave.type.updated",
    entityType: "LeaveType",
    entityId: created.id,
    after: { code: created.code, name: data.name, paid: data.paid },
  });
  return created;
}
