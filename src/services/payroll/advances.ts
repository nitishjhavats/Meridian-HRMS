import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { assertSameTenant, requireModule, requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import type { AdvanceRecoveryMode } from "@/domain/payroll/types";

/**
 * Salary advances.
 *
 * `/payroll/advances` has been in the navigation since the product had a
 * navigation, and has 404ed for every Admin and Owner who clicked it. The engine
 * has always known how to recover an advance; there was simply no way to issue
 * one outside a seed script.
 *
 * Recovery is not decided here. The advance carries a *mode* — all of it next
 * month, in instalments, a fixed sum, a percentage of net — and the payroll
 * engine works out what that means against the month's actual pay and the
 * minimum-net-pay floor. Deciding the amount here as well would put the same
 * arithmetic in two places, and they would disagree the first time somebody
 * joined mid-month.
 */

export interface AdvanceRow {
  id: string;
  employee: { id: string; name: string; employeeCode: string };
  amountPaise: number;
  recoveredPaise: number;
  outstandingPaise: number;
  status: string;
  issuedOn: Date;
  reason: string | null;
  recovery: AdvanceRecoveryMode;
  /** How many months have actually taken money off it. */
  instalmentsPaid: number;
}

export async function listAdvances(
  ctx: AuthContext,
  filters: { status?: string; employeeId?: string } = {},
): Promise<AdvanceRow[]> {
  requireOrg(ctx);
  // A read. `requireWrite` here refused the whole page the moment a trial
  // ended or a payment lapsed -- under a banner that had promised read-only.
  requirePermission(ctx, "advance.manage");
  requireModule(ctx, "payroll");

  const rows = await prisma.salaryAdvance.findMany({
    where: {
      organizationId: ctx.organizationId!,
      ...(filters.status ? { status: filters.status as never } : {}),
      ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
    },
    select: {
      id: true,
      amountPaise: true,
      recoveredPaise: true,
      status: true,
      issuedOn: true,
      reason: true,
      recovery: true,
      employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
      _count: { select: { recoveries: true } },
    },
    orderBy: [{ status: "asc" }, { issuedOn: "desc" }],
  });

  return rows.map((row) => ({
    id: row.id,
    employee: {
      id: row.employee.id,
      name: [row.employee.firstName, row.employee.lastName].filter(Boolean).join(" "),
      employeeCode: row.employee.employeeCode,
    },
    amountPaise: row.amountPaise,
    recoveredPaise: row.recoveredPaise,
    outstandingPaise: Math.max(0, row.amountPaise - row.recoveredPaise),
    status: row.status,
    issuedOn: row.issuedOn,
    reason: row.reason,
    recovery: row.recovery as AdvanceRecoveryMode,
    instalmentsPaid: row._count.recoveries,
  }));
}

export interface IssueAdvanceInput {
  employeeId: string;
  amountPaise: number;
  issuedOn: string;
  recovery: AdvanceRecoveryMode;
  reason?: string;
}

export async function issueAdvance(ctx: AuthContext, input: IssueAdvanceInput) {
  requireOrg(ctx);
  requireWrite(ctx, "advance.manage", "payroll");

  if (!(input.amountPaise > 0)) {
    throw new ValidationError("An advance has to be for some money.");
  }

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, organizationId: ctx.organizationId! },
    select: { id: true, firstName: true, active: true, employmentState: true, userId: true },
  });
  if (!employee) throw new NotFoundError("That employee");
  if (!employee.active || ["RESIGNED", "TERMINATED", "INACTIVE"].includes(employee.employmentState)) {
    throw new ValidationError(
      "That employment record is not active, so an advance cannot be issued against it.",
    );
  }

  // One at a time. Two live advances with different recovery modes is a
  // question about ordering that nobody has answered, and the engine would
  // simply take them in the order it found them.
  const existing = await prisma.salaryAdvance.findFirst({
    where: { employeeId: employee.id, status: "ACTIVE" },
    select: { id: true, amountPaise: true, recoveredPaise: true },
  });
  if (existing) {
    throw new ConflictError(
      `${employee.firstName} still owes ₹${((existing.amountPaise - existing.recoveredPaise) / 100).toLocaleString("en-IN")} on an earlier advance. Settle or write that off first.`,
    );
  }

  const advance = await prisma.salaryAdvance.create({
    data: {
      organizationId: ctx.organizationId!,
      employeeId: employee.id,
      amountPaise: input.amountPaise,
      issuedOn: new Date(`${input.issuedOn}T00:00:00.000Z`),
      recovery: input.recovery as object,
      reason: input.reason?.trim() || null,
      approvedById: ctx.userId,
      status: "ACTIVE",
    },
  });

  await writeAudit(ctx, {
    action: "advance.created",
    entityType: "SalaryAdvance",
    entityId: advance.id,
    after: {
      employeeId: employee.id,
      amountPaise: input.amountPaise,
      recovery: input.recovery,
      reason: advance.reason,
    },
  });

  if (employee.userId) {
    await notify.toUser(employee.userId, {
      type: "advance.issued",
      title: "A salary advance has been issued to you",
      body: "It will be recovered from your pay according to the agreed schedule.",
      link: "/me/salary",
    });
  }

  return advance;
}

/**
 * Ending an advance early.
 *
 * `CANCELLED` is for one issued by mistake — nothing was recovered and nothing
 * is owed. `WRITTEN_OFF` is a decision to stop recovering what is still
 * outstanding, which is a real cost to the organisation and is recorded as one.
 * Neither touches what has already been recovered: that money moved, and a
 * status change is not a way to un-move it.
 */
export async function closeAdvance(
  ctx: AuthContext,
  advanceId: string,
  status: "CANCELLED" | "WRITTEN_OFF",
  reason: string,
) {
  requireOrg(ctx);
  requireWrite(ctx, "advance.manage", "payroll");

  if (reason.trim().length < 4) {
    throw new ValidationError("Give a reason — it is shown in the audit log.");
  }

  const advance = await prisma.salaryAdvance.findUnique({ where: { id: advanceId } });
  assertSameTenant(ctx, advance, "That advance");

  if (advance!.status !== "ACTIVE") {
    throw new ConflictError("That advance is already closed.");
  }
  if (status === "CANCELLED" && advance!.recoveredPaise > 0) {
    throw new ConflictError(
      "Money has already been recovered against this advance, so it cannot be cancelled as though it never happened. Write off the remainder instead.",
    );
  }

  const updated = await prisma.salaryAdvance.update({
    where: { id: advanceId },
    data: { status, reason: reason.trim() },
  });

  await writeAudit(ctx, {
    action: status === "CANCELLED" ? "advance.cancelled" : "advance.written_off",
    entityType: "SalaryAdvance",
    entityId: advanceId,
    before: { status: advance!.status, outstandingPaise: advance!.amountPaise - advance!.recoveredPaise },
    after: { status, reason: reason.trim() },
  });

  return updated;
}
