import { Prisma } from "@prisma/client";
import type { PayrollRunStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertSameTenant,
  requireAnyPermission,
  requireModule,
  requireOrg,
  requirePermission,
  requireWritable,
  scopeFor,
  visibleEmployeeIds,
} from "@/lib/auth/guard";
import type { Scope } from "@/lib/auth/permissions";
import { ConflictError, NotFoundError, PayrollLockedError, ValidationError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/db/uniqueViolation";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { calculatePayroll } from "@/domain/payroll/engine";
import type { PayrollResult } from "@/domain/payroll/types";
import { endOfMonth, monthLabel, startOfMonth } from "@/domain/date";
import { getAttendanceRules, getPayrollPolicy } from "../policy";
import { buildPayrollInput, claimsRidingRun } from "./inputBuilder";

/**
 * Payroll runs.
 *
 * The lifecycle is deliberately one-way except for a single, permissioned exit:
 *
 *   DRAFT → CALCULATED → APPROVED → LOCKED
 *
 * A LOCKED run is immutable. It carries a snapshot of the policy it was computed
 * under, so changing the organisation's rules in June can never rewrite March.
 * "Unlocking" does not reopen the old run — it creates a **new revision**, and
 * the original stays exactly as it was paid.
 */

export interface RunSummary {
  id: string;
  periodYear: number;
  periodMonth: number;
  label: string;
  status: PayrollRunStatus;
  revision: number;
  employees: number;
  netPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  calculatedAt: Date | null;
  approvedAt: Date | null;
  lockedAt: Date | null;
}

interface RunTotals {
  netPaise: number;
  grossPaise: number;
  deductionsPaise: number;
  paidPaise: number;
  outstandingPaise: number;
}

function totalsOf(value: Prisma.JsonValue | null): RunTotals {
  const t = (value ?? {}) as Partial<RunTotals>;
  return {
    netPaise: t.netPaise ?? 0,
    grossPaise: t.grossPaise ?? 0,
    deductionsPaise: t.deductionsPaise ?? 0,
    paidPaise: t.paidPaise ?? 0,
    outstandingPaise: t.outstandingPaise ?? 0,
  };
}

// ------------------------------------------------------------------ audience

/**
 * Whose pay this caller is entitled to see.
 *
 * There is exactly one rule and it lives in `visibleEmployeeIds`: `null` is the
 * `.all` scope and means *no restriction*, while an empty array is its opposite
 * — a manager with nobody reporting to them, who must see no rows at all. Every
 * read below goes through this so the two can never be confused again.
 */
interface PayrollAudience {
  scope: Scope;
  /** `null` ⇒ the whole organisation. Otherwise exactly these employees. */
  employeeIds: string[] | null;
}

async function payrollAudience(ctx: AuthContext): Promise<PayrollAudience> {
  return {
    scope: scopeFor(ctx, "payroll.read"),
    employeeIds: await visibleEmployeeIds(ctx, "payroll.read"),
  };
}

interface RunFigures {
  employees: number;
  netPaise: number;
  paidPaise: number;
  outstandingPaise: number;
}

/**
 * The stored `totals` on a run are the organisation's, so a scoped viewer's
 * figures have to be summed from the items they may actually see. Disbursement
 * derives the organisation total the same way — from the items — so the two
 * agree by construction rather than by luck.
 */
async function figuresByRun(
  ctx: AuthContext & { organizationId: string },
  runIds: string[],
  employeeIds: string[],
): Promise<Map<string, RunFigures>> {
  if (runIds.length === 0) return new Map();

  const grouped = await prisma.payrollItem.groupBy({
    by: ["payrollRunId"],
    where: {
      organizationId: ctx.organizationId,
      payrollRunId: { in: runIds },
      employeeId: { in: employeeIds },
    },
    _count: { _all: true },
    _sum: { netPaise: true, paidPaise: true },
  });

  return new Map(
    grouped.map((group) => {
      const netPaise = group._sum.netPaise ?? 0;
      const paidPaise = group._sum.paidPaise ?? 0;
      return [
        group.payrollRunId,
        {
          employees: group._count._all,
          netPaise,
          paidPaise,
          // Never negative: an overpayment recorded against one person should
          // not read as the team being owed less than nothing.
          outstandingPaise: Math.max(netPaise - paidPaise, 0),
        },
      ] as const;
    }),
  );
}

export async function listRuns(ctx: AuthContext, year?: number): Promise<RunSummary[]> {
  requireOrg(ctx);
  // A run list is somebody else's pay, so it needs `.all` or `.team`. `.self` is
  // not a narrower version of this screen — it is /me/salary, which is a payslip.
  requireAnyPermission(ctx, ["payroll.read.all", "payroll.read.team"]);
  requireModule(ctx, "payroll");

  const audience = await payrollAudience(ctx);
  const scopedTo = audience.employeeIds;

  const runs = await prisma.payrollRun.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(year ? { periodYear: year } : {}),
      // A run containing none of this manager's team has nothing to tell them,
      // and an empty team matches no run at all — which is the intended answer,
      // not an edge case to paper over.
      ...(scopedTo === null ? {} : { items: { some: { employeeId: { in: scopedTo } } } }),
    },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, { revision: "desc" }],
    include: { _count: { select: { items: true } } },
  });

  const scopedFigures =
    scopedTo === null
      ? null
      : await figuresByRun(ctx, runs.map((r) => r.id), scopedTo);

  return runs.map((run) => {
    const stored = totalsOf(run.totals);
    // The same discriminator throughout: `null` ids ⇒ the organisation's own
    // stored totals, anything else ⇒ only what this reader's people add up to.
    const figures: RunFigures =
      scopedTo === null
        ? {
            employees: run._count.items,
            netPaise: stored.netPaise,
            paidPaise: stored.paidPaise,
            outstandingPaise: stored.outstandingPaise,
          }
        : (scopedFigures?.get(run.id) ?? {
            employees: 0,
            netPaise: 0,
            paidPaise: 0,
            outstandingPaise: 0,
          });

    return {
      id: run.id,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
      label: monthLabel(run.periodYear, run.periodMonth),
      status: run.status,
      revision: run.revision,
      employees: figures.employees,
      netPaise: figures.netPaise,
      paidPaise: figures.paidPaise,
      outstandingPaise: figures.outstandingPaise,
      calculatedAt: run.calculatedAt,
      approvedAt: run.approvedAt,
      lockedAt: run.lockedAt,
    };
  });
}

/** The newest revision for a period, which is the one anyone means by "March". */
export async function getRunForPeriod(ctx: AuthContext, year: number, month: number) {
  requireOrg(ctx);
  requireModule(ctx, "payroll");

  const run = await prisma.payrollRun.findFirst({
    where: { organizationId: ctx.organizationId, periodYear: year, periodMonth: month },
    orderBy: { revision: "desc" },
  });
  return run;
}

/**
 * Creates a run, or returns the existing one for that period.
 *
 * Creating is separate from calculating so an admin can open a month, look at
 * who is included, and only then commit to the numbers.
 */
export async function createRun(ctx: AuthContext, year: number, month: number) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.run");
  requireModule(ctx, "payroll");
  requireWritable(ctx);

  if (month < 1 || month > 12) throw new ValidationError("That is not a valid month.");

  const existing = await getRunForPeriod(ctx, year, month);
  if (existing) return existing;

  // Refuse to open a month that has not happened yet — payroll for a period
  // still in progress is guesswork, not payroll.
  const periodEnd = endOfMonth(year, month);
  if (new Date(`${periodEnd}T23:59:59Z`) > new Date()) {
    throw new ValidationError(
      `${monthLabel(year, month)} has not finished yet. Payroll can be run once the month is over.`,
    );
  }

  const run = await prisma.payrollRun.create({
    data: {
      organizationId: ctx.organizationId,
      periodYear: year,
      periodMonth: month,
      periodStart: new Date(`${startOfMonth(year, month)}T00:00:00.000Z`),
      periodEnd: new Date(`${periodEnd}T00:00:00.000Z`),
      status: "DRAFT",
      revision: 1,
      createdById: ctx.userId,
    },
  });

  await writeAudit(ctx, {
    action: "payroll.run_created",
    entityType: "PayrollRun",
    entityId: run.id,
    after: { period: monthLabel(year, month) },
  });

  return run;
}

export interface CalculationReport {
  runId: string;
  employees: number;
  skipped: { employeeId: string; name: string; reason: string }[];
  totals: RunTotals;
  warnings: number;
}

/**
 * Computes every employee's pay for the period.
 *
 * Safe to re-run while the status is DRAFT or CALCULATED — it replaces the
 * previous items rather than accumulating them. Once APPROVED or LOCKED it is
 * refused, because recalculating something already approved silently changes
 * what a person was told they would be paid. The only way forward from either
 * is the lifecycle's one exit: lock, then reopen as a new revision.
 */
export async function calculateRun(ctx: AuthContext, runId: string): Promise<CalculationReport> {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.run");
  requireModule(ctx, "payroll");
  requireWritable(ctx);

  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  assertSameTenant(ctx, run, "That payroll run");

  if (run!.status === "LOCKED") throw new PayrollLockedError();
  if (run!.status === "APPROVED") {
    // This used to say "reopen it before recalculating" -- but reopening is
    // for a locked run and refused for an approved one, so the message named
    // a way out that did not exist. Say the one that does.
    throw new ConflictError(
      "This run is already approved, so its figures are fixed. To change them, lock it and reopen it as a new revision.",
    );
  }

  const periodStart = startOfMonth(run!.periodYear, run!.periodMonth);
  const { policy, isDefault, errors } = await getPayrollPolicy(ctx, periodStart);
  if (errors.length > 0) {
    throw new ValidationError(
      "The payroll policy for this period is invalid, so nothing was calculated.",
      { issues: errors },
    );
  }
  // The attendance rule in force for the period, read once for the whole run:
  // a CHECKED_IN row the day-close never settled is worth whatever the
  // organisation's missing-checkout rule says, not the shipped default.
  const { missingCheckout } = await getAttendanceRules(ctx, periodStart);

  const employees = await prisma.employee.findMany({
    where: {
      organizationId: ctx.organizationId,
      // Anyone on the rolls at any point in the period is included; the engine
      // prorates a mid-month joiner or leaver from their own dates.
      joiningDate: { lte: run!.periodEnd },
      OR: [{ exitDate: null }, { exitDate: { gte: run!.periodStart } }],
    },
    select: { id: true, firstName: true, lastName: true },
    orderBy: { employeeCode: "asc" },
  });

  const skipped: CalculationReport["skipped"] = [];
  const results: { employeeId: string; result: PayrollResult }[] = [];

  for (const employee of employees) {
    const name = [employee.firstName, employee.lastName].filter(Boolean).join(" ");
    const input = await buildPayrollInput(prisma, {
      employeeId: employee.id,
      organizationId: ctx.organizationId,
      year: run!.periodYear,
      month: run!.periodMonth,
      policy,
      // So a recalculation picks up adjustments an administrator added since the
      // last one. On the first pass there is no item yet and none to find.
      payrollRunId: runId,
      missingCheckout,
    });

    if (!input) {
      skipped.push({ employeeId: employee.id, name, reason: "Not on the rolls during this period" });
      continue;
    }
    if (input.ctcMonthlyPaise <= 0) {
      skipped.push({ employeeId: employee.id, name, reason: "No salary structure assigned" });
      continue;
    }

    results.push({ employeeId: employee.id, result: calculatePayroll(input, policy) });
  }

  const totals: RunTotals = {
    netPaise: results.reduce((s, r) => s + r.result.netPaise, 0),
    grossPaise: results.reduce((s, r) => s + r.result.grossPaise, 0),
    deductionsPaise: results.reduce((s, r) => s + r.result.totalDeductionsPaise, 0),
    paidPaise: 0,
    outstandingPaise: results.reduce((s, r) => s + r.result.netPaise, 0),
  };

  await prisma.$transaction(async (tx) => {
    // Replace rather than accumulate; payments are re-attached below.
    await tx.payrollItem.deleteMany({ where: { payrollRunId: runId } });

    for (const { employeeId, result } of results) {
      await tx.payrollItem.create({
        data: {
          organizationId: ctx.organizationId!,
          payrollRunId: runId,
          employeeId,
          ctcMonthlyPaise: result.ctcMonthlyPaise,
          basisDays: result.days.basisDays,
          payableDays: result.days.payableDays,
          presentDays: result.days.presentDays,
          paidLeaveDays: result.days.paidLeaveDays,
          unpaidLeaveDays: result.days.unpaidLeaveDays,
          halfDays: result.days.halfDays,
          absentDays: result.days.absentDays,
          weekOffDays: result.days.weekOffDays,
          holidayDays: result.days.holidayDays,
          extraDays: result.days.extraDays,
          lateCount: result.days.lateCount,
          overtimeMinutes: result.days.overtimeMinutes,
          grossPaise: result.grossPaise,
          earningsPaise: result.totalEarningsPaise,
          deductionsPaise: result.totalDeductionsPaise,
          advanceRecoveredPaise: result.advanceRecoveredPaise,
          netPaise: result.netPaise,
          settlement: "UNPAID",
          earnings: result.earnings as object,
          deductions: result.deductions as object,
          // The trace is what makes every rupee explainable months later.
          trace: result.trace as object,
          warnings: result.warnings,
          // Carried through so the credit at lock uses exactly what the engine
          // computed, rather than re-deriving it from the policy and drifting.
          compOffCredits:
            result.compOffCredits.length > 0 ? (result.compOffCredits as object) : undefined,
          // The total already sits in `advanceRecoveredPaise`, but the total
          // cannot say which advance it came off, and that is exactly what the
          // write-back at lock needs.
          advanceRecoveries:
            result.advanceRecoveries.length > 0 ? (result.advanceRecoveries as object) : undefined,
        },
      });
    }

    await tx.payrollRun.update({
      where: { id: runId },
      data: {
        status: "CALCULATED",
        calculatedAt: new Date(),
        totals: totals as unknown as Prisma.InputJsonValue,
        // Snapshot taken at calculation, frozen for good at lock.
        policySnapshot: policy as unknown as Prisma.InputJsonValue,
        note: isDefault ? "Calculated with the default payroll policy" : null,
      },
    });
  });

  await writeAudit(ctx, {
    action: "payroll.calculated",
    entityType: "PayrollRun",
    entityId: runId,
    after: { employees: results.length, netPaise: totals.netPaise, skipped: skipped.length },
  });

  return {
    runId,
    employees: results.length,
    skipped,
    totals,
    warnings: results.reduce((s, r) => s + r.result.warnings.length, 0),
  };
}

export async function approveRun(ctx: AuthContext, runId: string) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.approve");
  requireWritable(ctx);

  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    include: { _count: { select: { items: true } } },
  });
  assertSameTenant(ctx, run, "That payroll run");

  if (run!.status !== "CALCULATED") {
    throw new ConflictError("Only a calculated run can be approved.");
  }
  if (run!._count.items === 0) {
    throw new ConflictError("This run has no employees in it.");
  }

  const updated = await prisma.payrollRun.update({
    where: { id: runId },
    data: { status: "APPROVED", approvedAt: new Date(), approvedById: ctx.userId },
  });

  await writeAudit(ctx, {
    action: "payroll.approved",
    entityType: "PayrollRun",
    entityId: runId,
    before: { status: run!.status },
    after: { status: "APPROVED" },
  });

  return updated;
}

/**
 * Locks the run.
 *
 * This is the point of no return: the policy snapshot becomes the permanent
 * record of how these numbers were produced, and nothing in the run can change
 * again. Disbursement continues against a locked run — paying people is not a
 * change to what they are owed.
 */
/**
 * Turns earned compensatory off into leave people can actually take.
 *
 * The engine has always computed this — `PayrollResult.compOffCredits` — and
 * nothing ever consumed it, so choosing `extraDay.mode: "COMP_OFF"` silently
 * threw the credit away. Somebody worked a seventh day and got nothing for it.
 *
 * It happens at lock rather than at calculate because calculate replaces its
 * items and may be re-run any number of times; crediting there would multiply
 * the days. `compOffCreditedAt` guards the remaining path — a run that is
 * unlocked and locked again does not credit twice.
 *
 * The credit raises `allocated`, not `used`: a comp-off day is entitlement the
 * employee earned, not consumption to be reversed.
 */
async function creditCompOff(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  runId: string,
): Promise<{ employees: number; days: number; unmatched: { employeeId: string; code: string }[] }> {
  const items = await tx.payrollItem.findMany({
    where: { payrollRunId: runId, compOffCreditedAt: null, NOT: { compOffCredits: { equals: Prisma.DbNull } } },
    select: { id: true, employeeId: true, compOffCredits: true },
  });
  if (items.length === 0) return { employees: 0, days: 0, unmatched: [] };

  const run = await tx.payrollRun.findUniqueOrThrow({
    where: { id: runId },
    select: { periodYear: true },
  });

  // Leave types are looked up by code once: the engine names the type it
  // credited, and a policy pointing at a code the organisation does not have is
  // a configuration error, not a reason to fail the lock.
  const types = await tx.leaveType.findMany({
    where: { organizationId: ctx.organizationId! },
    select: { id: true, code: true },
  });
  const byCode = new Map(types.map((t) => [t.code, t.id]));

  let employees = 0;
  let total = 0;
  const unmatched: { employeeId: string; code: string }[] = [];

  for (const item of items) {
    const credits = Array.isArray(item.compOffCredits)
      ? (item.compOffCredits as { leaveTypeCode?: string; days?: number }[])
      : [];

    let creditedForThisEmployee = 0;
    for (const credit of credits) {
      const leaveTypeId = credit.leaveTypeCode ? byCode.get(credit.leaveTypeCode) : undefined;
      const days = Number(credit.days ?? 0);

      /**
       * A code that matches nothing is recorded, not swallowed.
       *
       * This used to `continue` and then stamp `compOffCreditedAt` regardless,
       * so a leave type renamed or deactivated between calculating and locking
       * meant somebody who worked a rest day got nothing and no screen ever
       * said so. Activation refuses an unknown code now, and this is the case
       * activation cannot cover: the type existed then and does not now.
       */
      if (days > 0 && !leaveTypeId) {
        unmatched.push({ employeeId: item.employeeId, code: credit.leaveTypeCode ?? "" });
      }
      if (!leaveTypeId || !(days > 0)) continue;

      await tx.leaveBalance.upsert({
        where: {
          employeeId_leaveTypeId_year: {
            employeeId: item.employeeId,
            leaveTypeId,
            year: run.periodYear,
          },
        },
        create: {
          organizationId: ctx.organizationId!,
          employeeId: item.employeeId,
          leaveTypeId,
          year: run.periodYear,
          allocated: days,
        },
        update: { allocated: { increment: days } },
      });
      creditedForThisEmployee += days;
    }

    await tx.payrollItem.update({
      where: { id: item.id },
      data: { compOffCreditedAt: new Date() },
    });

    if (creditedForThisEmployee > 0) {
      employees += 1;
      total += creditedForThisEmployee;
    }
  }

  /**
   * A configuration error is written down rather than swallowed.
   *
   * Not a reason to fail the lock -- payroll is correct, the money is right,
   * and refusing to close the month over a leave type would be worse. But an
   * organisation that worked people on rest days and credited them nothing has
   * to be able to find out, and this is the only moment anybody could.
   */
  if (unmatched.length > 0) {
    await writeAudit(ctx, {
      action: "payroll.locked",
      entityType: "PayrollRun",
      entityId: runId,
      metadata: {
        compOffNotCredited: unmatched.length,
        codes: [...new Set(unmatched.map((u) => u.code))],
        reason: "no active leave type has that code, so the days were credited nowhere",
      },
    });
  }

  return { employees, days: total, unmatched };
}

/**
 * Writes recovered advances back against the advances they came off.
 *
 * The engine has always computed this correctly and the total has always been
 * stored on the payroll item — but nothing ever created an `AdvanceRecoveryEntry`
 * or moved `SalaryAdvance.recoveredPaise`. So `outstanding = amount - recovered`
 * kept computing against a zero, the balance never fell, and the same advance was
 * deducted from somebody's pay every single month, for ever. It is not a missing
 * feature; it is a wrong answer.
 *
 * Two things make it safe to run inside the lock:
 *
 *   - `@@unique([advanceId, payrollItemId])` on the entry means a second attempt
 *     for the same item cannot double-count, whatever else goes wrong;
 *   - `advancesAppliedAt` is stamped on the item, so unlocking and locking again
 *     skips it entirely rather than relying on the constraint to catch it.
 */
async function applyAdvanceRecoveries(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  runId: string,
): Promise<{ employees: number; amountPaise: number; settled: number }> {
  const items = await tx.payrollItem.findMany({
    where: {
      payrollRunId: runId,
      advancesAppliedAt: null,
      NOT: { advanceRecoveries: { equals: Prisma.DbNull } },
    },
    select: { id: true, advanceRecoveries: true },
  });
  if (items.length === 0) return { employees: 0, amountPaise: 0, settled: 0 };

  const run = await tx.payrollRun.findUniqueOrThrow({
    where: { id: runId },
    select: { periodYear: true, periodMonth: true },
  });

  let employees = 0;
  let total = 0;
  let settled = 0;

  for (const item of items) {
    const recoveries = Array.isArray(item.advanceRecoveries)
      ? (item.advanceRecoveries as { advanceId?: string; amountPaise?: number }[])
      : [];

    let recoveredForThisEmployee = 0;

    for (const recovery of recoveries) {
      const advanceId = recovery.advanceId;
      const amountPaise = Number(recovery.amountPaise ?? 0);
      if (!advanceId || !(amountPaise > 0)) continue;

      // Scoped to the tenant: the id came out of a JSON column, and a column is
      // not a foreign key check.
      const advance = await tx.salaryAdvance.findFirst({
        where: { id: advanceId, organizationId: ctx.organizationId! },
        select: { id: true, amountPaise: true, recoveredPaise: true, status: true },
      });
      if (!advance) continue;

      await tx.advanceRecoveryEntry.create({
        data: {
          advanceId: advance.id,
          payrollItemId: item.id,
          amountPaise,
          periodYear: run.periodYear,
          periodMonth: run.periodMonth,
        },
      });

      const recovered = advance.recoveredPaise + amountPaise;
      await tx.salaryAdvance.update({
        where: { id: advance.id },
        data: {
          recoveredPaise: recovered,
          // Fully repaid, so it stops being offered to next month's engine.
          ...(recovered >= advance.amountPaise ? { status: "RECOVERED" as const } : {}),
        },
      });
      if (recovered >= advance.amountPaise && advance.status === "ACTIVE") settled += 1;

      recoveredForThisEmployee += amountPaise;
    }

    await tx.payrollItem.update({
      where: { id: item.id },
      data: { advancesAppliedAt: new Date() },
    });

    if (recoveredForThisEmployee > 0) {
      employees += 1;
      total += recoveredForThisEmployee;
    }
  }

  return { employees, amountPaise: total, settled };
}

/**
 * Mark this month's reimbursements paid, at the moment the run is locked.
 *
 * The third instance of the same shape as the two money bugs already fixed, and
 * the worst of them: nothing marked a claim paid, and nothing set the payroll
 * month on approval either, so `buildPayrollInput`'s period filter matched
 * nothing and **no approved reimbursement had ever reached a payslip**. The
 * employee's notification said "it will be paid with your salary" and it never
 * was.
 *
 * Stamped against the run, not the item, because recalculating a run deletes
 * and rebuilds its items. Idempotent by the `status: "APPROVED"` filter: a
 * relock finds nothing left to mark.
 */
async function markReimbursementsPaid(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  runId: string,
): Promise<{ claims: number; amountPaise: number }> {
  const run = await tx.payrollRun.findUniqueOrThrow({
    where: { id: runId },
    select: {
      periodYear: true,
      periodMonth: true,
      items: { select: { employeeId: true } },
    },
  });

  const employeeIds = run.items.map((i) => i.employeeId);
  if (employeeIds.length === 0) return { claims: 0, amountPaise: 0 };

  // Literally the same predicate the input builder used to decide what these
  // payslips showed, so the two cannot disagree about what this run pays.
  //
  // Narrowed to the claims not yet stamped. The predicate's other arm is the
  // claims this run has *already* paid — they are on the payslip and want no
  // second stamp, and excluding them here is what makes a relock a no-op
  // instead of moving `paidAt` and re-reporting money as newly paid.
  const claims = await tx.reimbursementClaim.findMany({
    where: {
      AND: [
        claimsRidingRun({
          organizationId: ctx.organizationId!,
          periodEnd: endOfMonth(run.periodYear, run.periodMonth),
          payrollRunId: runId,
        }),
        { employeeId: { in: employeeIds }, status: "APPROVED", paidInRunId: null },
      ],
    },
    select: { id: true, approvedPaise: true },
  });
  if (claims.length === 0) return { claims: 0, amountPaise: 0 };

  await tx.reimbursementClaim.updateMany({
    where: { id: { in: claims.map((c) => c.id) } },
    data: { status: "PAID", paidInRunId: runId, paidAt: new Date() },
  });

  return {
    claims: claims.length,
    amountPaise: claims.reduce((sum, c) => sum + c.approvedPaise, 0),
  };
}

export async function lockRun(ctx: AuthContext, runId: string) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.finalize");
  requireWritable(ctx);

  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  assertSameTenant(ctx, run, "That payroll run");

  if (run!.status === "LOCKED") return run!;
  if (run!.status !== "APPROVED") {
    throw new ConflictError("Approve the run before locking it.");
  }

  const applied = await prisma.$transaction(async (tx) => {
    await tx.payrollRun.update({
      where: { id: runId },
      data: { status: "LOCKED", lockedAt: new Date(), lockedById: ctx.userId },
    });
    // Both in the lock, both idempotent, both stamped on the item they came
    // from: locking is the moment the month's arithmetic becomes real.
    const credited = await creditCompOff(tx, ctx, runId);
    const advances = await applyAdvanceRecoveries(tx, ctx, runId);
    const reimbursements = await markReimbursementsPaid(tx, ctx, runId);
    return { credited, advances, reimbursements };
  });
  const credited = applied.credited;

  const updated = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });

  if (credited.days > 0) {
    await writeAudit(ctx, {
      action: "leave.balance_adjusted",
      entityType: "PayrollRun",
      entityId: runId,
      after: { reason: "compensatory off earned", employees: credited.employees, days: credited.days },
    });
  }

  if (applied.reimbursements.claims > 0) {
    await writeAudit(ctx, {
      action: "reimbursement.paid",
      entityType: "PayrollRun",
      entityId: runId,
      after: {
        claims: applied.reimbursements.claims,
        amountPaise: applied.reimbursements.amountPaise,
      },
    });
  }

  if (applied.advances.amountPaise > 0) {
    await writeAudit(ctx, {
      action: "advance.recovered",
      entityType: "PayrollRun",
      entityId: runId,
      after: {
        employees: applied.advances.employees,
        amountPaise: applied.advances.amountPaise,
        advancesFullyRepaid: applied.advances.settled,
      },
    });
  }

  await writeAudit(ctx, {
    action: "payroll.locked",
    entityType: "PayrollRun",
    entityId: runId,
    after: { status: "LOCKED", period: monthLabel(run!.periodYear, run!.periodMonth) },
  });

  await notify.toOrgRoles(ctx.organizationId, ["ORG_OWNER", "ADMIN", "HR_MANAGER"], {
    type: "payroll.locked",
    title: `${monthLabel(run!.periodYear, run!.periodMonth)} payroll is locked`,
    body: "Salary slips can be generated and disbursement recorded.",
    link: `/payroll/${runId}`,
  });

  return updated;
}

/**
 * Reopens a period as a **new revision**.
 *
 * The locked run is left untouched — it is the record of what was actually paid.
 * A fresh revision is created alongside it, carrying the payments already made
 * so the outstanding balance stays right.
 *
 * The one-off adjustments come with it. An adjustment belongs to the run it was
 * added on -- the input builder reads only the run being calculated -- so a
 * revision that started empty calculated without the festival bonus the locked
 * run had paid, and nothing said so: net was simply lower, and the Adjust dialog
 * on the revision read "Nothing adjusted this month". Reopening exists to
 * correct a month, not to forget what was decided about it, so every adjustment
 * on the source run is copied onto the revision in the same transaction as the
 * revision itself. Anyone who wants one gone removes it there, on purpose,
 * before recalculating.
 */
export async function reopenRun(ctx: AuthContext, runId: string, reason: string) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.unlock");
  requireWritable(ctx);
  if (!reason.trim()) throw new ValidationError("Give a reason — it is written to the audit log.");

  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  assertSameTenant(ctx, run, "That payroll run");
  if (run!.status !== "LOCKED") {
    throw new ConflictError("Only a locked run needs reopening.");
  }

  const period = monthLabel(run!.periodYear, run!.periodMonth);

  const { revision, carried } = await prisma
    .$transaction(async (tx) => {
      const latest = await tx.payrollRun.findFirst({
        where: {
          organizationId: ctx.organizationId!,
          periodYear: run!.periodYear,
          periodMonth: run!.periodMonth,
        },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });

      // Read before the revision exists, so a copy can never be mistaken for
      // something added to the revision afterwards.
      const adjustments = await tx.payrollAdjustment.findMany({
        where: { organizationId: ctx.organizationId!, payrollRunId: run!.id },
        select: {
          employeeId: true,
          code: true,
          label: true,
          kind: true,
          amountPaise: true,
          reason: true,
        },
        orderBy: { createdAt: "asc" },
      });

      const carriedNote =
        adjustments.length > 0
          ? ` · ${adjustments.length} ${adjustments.length === 1 ? "adjustment" : "adjustments"} carried over from revision ${run!.revision}`
          : "";

      const revision = await tx.payrollRun.create({
        data: {
          organizationId: ctx.organizationId!,
          periodYear: run!.periodYear,
          periodMonth: run!.periodMonth,
          periodStart: run!.periodStart,
          periodEnd: run!.periodEnd,
          status: "DRAFT",
          revision: (latest?.revision ?? 1) + 1,
          note: `Revision of ${period} — ${reason.trim()}${carriedNote}`,
          createdById: ctx.userId,
        },
      });

      if (adjustments.length > 0) {
        await tx.payrollAdjustment.createMany({
          data: adjustments.map((adjustment) => ({
            organizationId: ctx.organizationId!,
            payrollRunId: revision.id,
            employeeId: adjustment.employeeId,
            code: adjustment.code,
            label: adjustment.label,
            kind: adjustment.kind,
            amountPaise: adjustment.amountPaise,
            reason: adjustment.reason,
            // The person reopening is the one who chose to carry them; the
            // audit row on the original still names whoever first added each.
            createdById: ctx.userId,
          })),
        });
      }

      return { revision, carried: adjustments.length };
    })
    .catch((error: unknown) => {
      // Two people reopening the same month at once both compute the same
      // next revision number; the unique index lets exactly one through. The
      // other is told, not handed a 500.
      if (isUniqueViolation(error, "revision")) {
        throw new ConflictError(
          `${period} was just reopened by somebody else. Refresh to see the new revision.`,
        );
      }
      throw error;
    });

  await writeAudit(ctx, {
    action: "payroll.unlocked",
    entityType: "PayrollRun",
    entityId: run!.id,
    metadata: {
      newRunId: revision.id,
      revision: revision.revision,
      reason: reason.trim(),
      adjustmentsCarried: carried,
    },
  });

  return revision;
}

// ------------------------------------------------------------------ reading

export interface PayrollItemRow {
  id: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  designation: string | null;
  ctcMonthlyPaise: number;
  payableDays: number;
  basisDays: number;
  presentDays: number;
  absentDays: number;
  paidLeaveDays: number;
  lateCount: number;
  overtimeMinutes: number;
  grossPaise: number;
  deductionsPaise: number;
  advanceRecoveredPaise: number;
  netPaise: number;
  paidPaise: number;
  settlement: string;
  warnings: string[];
}

/**
 * A payroll run as a reader is allowed to see it.
 *
 * The run row is narrowed deliberately rather than handed over whole: it carries
 * `totals` for the entire organisation and the policy snapshot, and a manager
 * reading their team's page must not receive either — not in the markup, and not
 * in the JSON behind it.
 */
export interface RunDetail {
  run: {
    id: string;
    periodYear: number;
    periodMonth: number;
    periodStart: Date;
    periodEnd: Date;
    status: PayrollRunStatus;
    revision: number;
    note: string | null;
    calculatedAt: Date | null;
    approvedAt: Date | null;
    lockedAt: Date | null;
  };
  label: string;
  totals: RunTotals;
  items: PayrollItemRow[];
  /** True when the figures above cover only part of the organisation. */
  scoped: boolean;
  scope: Scope;
}

export async function getRunDetail(ctx: AuthContext, runId: string): Promise<RunDetail> {
  requireOrg(ctx);
  requireModule(ctx, "payroll");

  const run = await prisma.payrollRun.findUnique({ where: { id: runId } });
  assertSameTenant(ctx, run, "That payroll run");

  // An Admin sees the organisation; a Team Lead sees their reporting line;
  // anyone else only ever sees their own row.
  const audience = await payrollAudience(ctx);
  const scopeIds = audience.employeeIds;

  const items = await prisma.payrollItem.findMany({
    where: {
      organizationId: ctx.organizationId,
      payrollRunId: runId,
      ...(scopeIds === null ? {} : { employeeId: { in: scopeIds } }),
    },
    include: {
      employee: {
        select: {
          employeeCode: true,
          firstName: true,
          lastName: true,
          designation: { select: { title: true } },
        },
      },
    },
    orderBy: { employee: { employeeCode: "asc" } },
  });

  const rows: PayrollItemRow[] = items.map((item) => ({
    id: item.id,
    employeeId: item.employeeId,
    employeeCode: item.employee.employeeCode,
    name: [item.employee.firstName, item.employee.lastName].filter(Boolean).join(" "),
    designation: item.employee.designation?.title ?? null,
    ctcMonthlyPaise: item.ctcMonthlyPaise,
    payableDays: Number(item.payableDays),
    basisDays: Number(item.basisDays),
    presentDays: Number(item.presentDays),
    absentDays: Number(item.absentDays),
    paidLeaveDays: Number(item.paidLeaveDays),
    lateCount: item.lateCount,
    overtimeMinutes: item.overtimeMinutes,
    grossPaise: item.grossPaise,
    deductionsPaise: item.deductionsPaise,
    advanceRecoveredPaise: item.advanceRecoveredPaise,
    netPaise: item.netPaise,
    paidPaise: item.paidPaise,
    settlement: item.settlement,
    warnings: item.warnings,
  }));

  // The stored totals are the organisation's. A scoped reader gets the sum of
  // the lines they can see and nothing else, so the header can never quote them
  // a number that includes people they are not allowed to know about.
  const visibleNetPaise = sumBy(rows, (r) => r.netPaise);
  const visiblePaidPaise = sumBy(rows, (r) => r.paidPaise);
  const totals: RunTotals =
    scopeIds === null
      ? totalsOf(run!.totals)
      : {
          netPaise: visibleNetPaise,
          grossPaise: sumBy(rows, (r) => r.grossPaise),
          deductionsPaise: sumBy(rows, (r) => r.deductionsPaise),
          paidPaise: visiblePaidPaise,
          outstandingPaise: Math.max(visibleNetPaise - visiblePaidPaise, 0),
        };

  return {
    run: {
      id: run!.id,
      periodYear: run!.periodYear,
      periodMonth: run!.periodMonth,
      periodStart: run!.periodStart,
      periodEnd: run!.periodEnd,
      status: run!.status,
      revision: run!.revision,
      note: run!.note,
      calculatedAt: run!.calculatedAt,
      approvedAt: run!.approvedAt,
      lockedAt: run!.lockedAt,
    },
    label: monthLabel(run!.periodYear, run!.periodMonth),
    totals,
    items: rows,
    scoped: scopeIds !== null,
    scope: audience.scope,
  };
}

function sumBy<T>(rows: T[], value: (row: T) => number): number {
  return rows.reduce((sum, row) => sum + value(row), 0);
}

/** One employee's full breakdown, including the trace behind every amount. */
export async function getPayrollItem(ctx: AuthContext, itemId: string) {
  requireOrg(ctx);
  requireModule(ctx, "payroll");

  const item = await prisma.payrollItem.findUnique({
    where: { id: itemId },
    include: {
      run: { select: { periodYear: true, periodMonth: true, status: true, organizationId: true } },
      employee: {
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          designation: { select: { title: true } },
          department: { select: { name: true } },
        },
      },
      payments: { orderBy: { paidOn: "asc" } },
    },
  });

  assertSameTenant(ctx, item ? { organizationId: item.organizationId } : null, "That payslip");

  // Everyone may read their own; seeing anyone else's needs the wider scope.
  const isOwn = ctx.employeeId === item!.employeeId;
  if (!isOwn) {
    const { employeeIds } = await payrollAudience(ctx);
    if (employeeIds !== null && !employeeIds.includes(item!.employeeId)) {
      throw new NotFoundError("That payslip");
    }
  }

  return {
    ...item!,
    label: monthLabel(item!.run.periodYear, item!.run.periodMonth),
    name: [item!.employee.firstName, item!.employee.lastName].filter(Boolean).join(" "),
  };
}
