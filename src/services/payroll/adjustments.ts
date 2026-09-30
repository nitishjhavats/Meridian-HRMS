import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { assertSameTenant, requireOrg, requireWrite } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";

/**
 * One-off changes to a person's pay for one month.
 *
 * A bonus, a recovery, a correction somebody agreed verbally — things a salary
 * structure should not learn permanently. The rows have existed since the schema
 * was written and nothing could create them, so `payroll.adjust` gated nothing.
 *
 * They are attached to the run and the employee, not to a `PayrollItem`, because
 * recalculating a run deletes and rebuilds its items. An adjustment that
 * cascaded away with them would apply once and then silently stop, which is
 * worse than never applying.
 *
 * Nothing here touches money directly. An adjustment is an *input*; the engine
 * reads it on the next calculation and the payslip's trace shows it as a line
 * like any other. That is why adding one leaves the run's figures stale until it
 * is recalculated, and why the screen says so.
 */

export interface AdjustmentRow {
  id: string;
  code: string;
  label: string;
  kind: string;
  amountPaise: number;
  reason: string | null;
  createdAt: Date;
}

export async function listAdjustments(
  ctx: AuthContext,
  runId: string,
  employeeId: string,
): Promise<AdjustmentRow[]> {
  requireOrg(ctx);

  return prisma.payrollAdjustment.findMany({
    where: { organizationId: ctx.organizationId!, payrollRunId: runId, employeeId },
    select: {
      id: true,
      code: true,
      label: true,
      kind: true,
      amountPaise: true,
      reason: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export interface AddAdjustmentInput {
  payrollRunId: string;
  employeeId: string;
  label: string;
  kind: "EARNING" | "DEDUCTION";
  amountPaise: number;
  reason?: string;
}

export async function addAdjustment(ctx: AuthContext, input: AddAdjustmentInput) {
  requireOrg(ctx);
  requireWrite(ctx, "payroll.adjust", "payroll");

  if (!(input.amountPaise > 0)) {
    throw new ValidationError("An adjustment has to be for some money. Use the kind to say which way it goes.");
  }

  const run = await prisma.payrollRun.findUnique({
    where: { id: input.payrollRunId },
    select: { id: true, organizationId: true, status: true },
  });
  assertSameTenant(ctx, run, "That payroll run");

  // A locked run is what was paid. Changing it afterwards would make the
  // payslip somebody already has disagree with the record. An approved run is
  // one step short of that and no calculation will touch it again, so a line
  // added now would sit beside figures that never include it -- and be carried
  // onto the next revision unnoticed. The dialog says so; the service has to.
  if (run!.status === "LOCKED") {
    throw new ConflictError("This run is locked. Reopen it as a new revision to change anything.");
  }
  if (run!.status === "APPROVED") {
    throw new ConflictError(
      "This run is approved, so its figures are fixed. Lock it and reopen it as a new revision to change them.",
    );
  }

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, organizationId: ctx.organizationId! },
    select: { id: true, firstName: true },
  });
  if (!employee) throw new NotFoundError("That employee");

  // A stable, readable code so the trace line and the payslip name it the same
  // way every month.
  const code = `ADJ_${input.label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 24) || "MANUAL"}`;

  const adjustment = await prisma.payrollAdjustment.create({
    data: {
      organizationId: ctx.organizationId!,
      payrollRunId: run!.id,
      employeeId: employee.id,
      code,
      label: input.label.trim(),
      kind: input.kind,
      amountPaise: input.amountPaise,
      reason: input.reason?.trim() || null,
      createdById: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payroll.adjusted",
    entityType: "PayrollAdjustment",
    entityId: adjustment.id,
    after: {
      employeeId: employee.id,
      payrollRunId: run!.id,
      label: adjustment.label,
      kind: input.kind,
      amountPaise: input.amountPaise,
      reason: adjustment.reason,
    },
  });

  return adjustment;
}

export async function removeAdjustment(ctx: AuthContext, adjustmentId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "payroll.adjust", "payroll");

  const adjustment = await prisma.payrollAdjustment.findUnique({
    where: { id: adjustmentId },
    select: {
      id: true,
      organizationId: true,
      label: true,
      amountPaise: true,
      kind: true,
      run: { select: { status: true } },
    },
  });
  assertSameTenant(ctx, adjustment, "That adjustment");

  if (adjustment!.run.status === "LOCKED") {
    throw new ConflictError("This run is locked. Reopen it as a new revision to change anything.");
  }
  if (adjustment!.run.status === "APPROVED") {
    throw new ConflictError(
      "This run is approved, so its figures are fixed. Lock it and reopen it as a new revision to change them.",
    );
  }

  await prisma.payrollAdjustment.delete({ where: { id: adjustmentId } });

  await writeAudit(ctx, {
    action: "payroll.adjusted",
    entityType: "PayrollAdjustment",
    entityId: adjustmentId,
    before: {
      label: adjustment!.label,
      kind: adjustment!.kind,
      amountPaise: adjustment!.amountPaise,
    },
    after: { removed: true },
  });
}
