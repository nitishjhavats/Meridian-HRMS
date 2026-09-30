import type { FnfStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { storage } from "@/lib/storage";
import { MONTH_NAMES, type DateOnly, todayInZone } from "@/domain/date";
import { paiseToWords } from "@/domain/money";
import { formatPdfMoney } from "@/lib/pdf/fonts";
import { documentHeader } from "@/lib/pdf/orgHeader";
import { formatPaise } from "@/domain/money";
import { accruedForRow, monthsWorkedInYear } from "@/domain/leave";
import {
  allocationOverrides,
  designationAllocation,
  resolveAllocation,
} from "@/domain/leave/allocation";
import { getFnfPolicy, getPayrollPolicy } from "@/services/policy";
import type { PayrollPolicy } from "@/domain/payroll/types";
import {
  type FnfInput,
  type FnfLine as ComputedLine,
  type FnfPolicy,
  computeFnf,
} from "@/domain/payroll/fnf";
import { renderFnfPdf } from "@/lib/pdf/fnf";

/**
 * Full and final settlement.
 *
 * The arithmetic is not here — `computeFnf()` in the domain layer does it and is
 * tested there. This file's job is to assemble the inputs honestly from the
 * database, persist what came out, and freeze it on approval.
 *
 * The freeze matters. Once approved, the settlement carries a `snapshot` of the
 * inputs and policy it was computed from, so recomputing later cannot silently
 * change a figure somebody has already been told. Same discipline as a locked
 * payroll run.
 */

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/** "15 May 2021" — a date a person reads, not an ISO string. */
function readableDate(date: DateOnly | null): string | null {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;
}

/**
 * The components of a stored salary structure.
 *
 * Accepts either the bare array that is actually written, or a `{ components }`
 * wrapper, so a change in either direction cannot silently zero a settlement.
 */
function readComponents(structure: unknown): { code: string; amountPaise: number }[] {
  const raw = Array.isArray(structure)
    ? structure
    : ((structure as { components?: unknown } | null)?.components ?? []);
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    const c = entry as { code?: unknown; amountPaise?: unknown };
    return typeof c.code === "string" && typeof c.amountPaise === "number"
      ? [{ code: c.code, amountPaise: c.amountPaise }]
      : [];
  });
}

/**
 * Gathers everything the calculator needs.
 *
 * Anything that cannot be established is reported rather than assumed — a
 * settlement built on a guessed salary is worse than one that refuses to
 * compute.
 */
async function assembleInput(
  ctx: AuthContext,
  exitRecordId: string,
): Promise<{
  input: FnfInput;
  problems: string[];
  employeeId: string;
  payrollPolicy: PayrollPolicy;
  fnfPolicy: FnfPolicy;
}> {
  const record = await prisma.exitRecord.findFirst({
    where: { id: exitRecordId, organizationId: ctx.organizationId! },
    include: {
      employee: {
        select: {
          id: true,
          employeeCode: true,
          joiningDate: true,
          firstName: true,
          lastName: true,
          designationId: true,
          user: { select: { name: true } },
        },
      },
    },
  });
  if (!record) throw new NotFoundError("That exit");

  const problems: string[] = [];
  const lastWorkingDay = toDateOnly(record.lastWorkingDay);
  const employeeId = record.employeeId;

  if (!record.employee.joiningDate) {
    throw new ValidationError("This employee has no joining date, so service cannot be computed.");
  }

  const [profile, balances, advances, assets, allocationRows, payrollPolicy, fnfPolicy] = await Promise.all([
    // Every one of these carries `organizationId` as well as `employeeId`.
    // They are reachable only through an exit record that was already fetched
    // with the tenant filter, so none is exploitable today — but these four
    // between them decide what somebody is paid on the way out, and a `where`
    // that does not start from the tenant is the shape that stops being safe
    // the moment somebody refactors the caller.
    prisma.salaryProfile.findFirst({
      where: {
        organizationId: ctx.organizationId!,
        employeeId,
        effectiveFrom: { lte: record.lastWorkingDay },
      },
      orderBy: { effectiveFrom: "desc" },
      select: { ctcMonthlyPaise: true, structure: true },
    }),
    prisma.leaveBalance.findMany({
      where: {
        organizationId: ctx.organizationId!,
        employeeId,
        year: Number(lastWorkingDay.slice(0, 4)),
      },
      select: {
        leaveTypeId: true,
        allocated: true,
        accrued: true,
        used: true,
        carriedForward: true,
        encashed: true,
        leaveType: {
          select: {
            code: true,
            accrualMode: true,
            annualAllocation: true,
            monthlyAccrual: true,
          },
        },
      },
    }),
    prisma.salaryAdvance.findMany({
      where: { organizationId: ctx.organizationId!, employeeId, status: "ACTIVE" },
      select: { amountPaise: true, recoveredPaise: true },
    }),
    prisma.assetAssignment.findMany({
      where: { organizationId: ctx.organizationId!, employeeId, returnedOn: null },
      select: { recoveryPaise: true, asset: { select: { name: true, assetTag: true } } },
    }),
    // What this person's designation grants of each type. Encashment is money,
    // and it was being computed from the company-wide figure for everybody.
    prisma.designationLeaveAllocation.findMany({
      where: { organizationId: ctx.organizationId! },
      select: { leaveTypeId: true, designationId: true, annualAllocation: true },
    }),
    getPayrollPolicy(ctx, lastWorkingDay),
    getFnfPolicy(ctx, lastWorkingDay),
  ]);

  if (!profile) {
    throw new ValidationError("This employee has no salary profile, so nothing can be settled.");
  }

  // The basis component for gratuity and encashment, from the salary structure
  // that was in force on the last working day.
  //
  // `structure` is stored as a bare array of components. It is read through a
  // tolerant accessor because a settlement that silently computes zero because
  // of a shape mismatch is the worst possible failure here — it looks like a
  // valid answer.
  const basisCode = fnfPolicy.policy.gratuity.basisComponentCode;
  const components = readComponents(profile.structure);
  const basisMonthly = components.find((c) => c.code === basisCode)?.amountPaise ?? 0;

  if (basisMonthly === 0) {
    problems.push(
      `No ${basisCode} component found in the salary structure, so gratuity and leave encashment are computed as zero.`,
    );
  }

  const overrides = allocationOverrides(allocationRows);

  const advanceOutstanding = advances.reduce(
    (sum, a) => sum + Math.max(0, a.amountPaise - a.recoveredPaise),
    0,
  );

  const assetRecovery = assets.reduce((sum, a) => sum + (a.recoveryPaise ?? 0), 0);
  const unvalued = assets.filter((a) => a.recoveryPaise == null);
  if (unvalued.length > 0) {
    problems.push(
      `${unvalued.length} asset(s) are still out (${unvalued
        .map((a) => a.asset.assetTag)
        .join(", ")}) with no recovery value set.`,
    );
  }

  return {
    employeeId,
    problems,
    input: {
      employee: {
        id: employeeId,
        name: record.employee.user?.name ?? record.employee.employeeCode,
        joinedOn: toDateOnly(record.employee.joiningDate),
      },
      lastWorkingDay,
      // The last month's salary is run through normal payroll, not here.
      finalSalaryPaise: 0,
      basisComponentMonthlyPaise: basisMonthly,
      leaveBalances: balances.map((b) => {
        const accrues = b.leaveType.accrualMode === "MONTHLY";
        // The designation layer, which this file read past entirely: the
        // annual cap on an accrual type came from `LeaveType.annualAllocation`,
        // so two people leaving on the same day were encashed against the same
        // entitlement however different the two designation screens said their
        // entitlements were. The row's own `allocated` still outranks it.
        const designation = designationAllocation(
          overrides,
          b.leaveTypeId,
          record.employee.designationId,
        );
        // `accrued` is a stored column nothing recomputes, and a row created by
        // an approval or by the year-end carry-forward run holds a zero in it.
        // Encashing what that column literally says would settle an accrual
        // type at nothing but the days carried in — real money, quietly short.
        const granted = accrues
          ? accruedForRow(Number(b.accrued), {
              annualAllocation: resolveAllocation({
                designation,
                type: b.leaveType.annualAllocation,
              }),
              monthlyAccrual: Number(b.leaveType.monthlyAccrual),
              accrualMode: "MONTHLY",
              // Counted to the last working day, not to today: leave stops
              // accruing when somebody leaves.
              monthsWorked: monthsWorkedInYear(
                Number(lastWorkingDay.slice(0, 4)),
                toDateOnly(record.employee.joiningDate!),
                lastWorkingDay,
              ),
            })
          : resolveAllocation({
              personal: b.allocated,
              designation,
              type: b.leaveType.annualAllocation,
            });
        return {
          leaveTypeCode: b.leaveType.code,
          days: Math.max(
            0,
            granted + Number(b.carriedForward) - Number(b.used) - Number(b.encashed),
          ),
        };
      }),
      noticeDaysRequired: record.noticeDaysRequired,
      noticeDaysServed: record.noticeDaysServed,
      advanceOutstandingPaise: advanceOutstanding,
      assetRecoveryPaise: assetRecovery,
      adjustments: [],
    },
    payrollPolicy: payrollPolicy.policy,
    fnfPolicy: fnfPolicy.policy,
  };
}

export interface FnfPreview {
  lines: ComputedLine[];
  earningsPaise: number;
  deductionsPaise: number;
  netPaise: number;
  netInWords: string;
  yearsOfService: number;
  warnings: string[];
  /** Things a person should look at before approving. */
  problems: string[];
}

/** Computes without saving, so the numbers can be checked first. */
export async function previewFnf(ctx: AuthContext, exitRecordId: string): Promise<FnfPreview> {
  requireOrg(ctx);
  requirePermission(ctx, "exit.settle");

  const { input, problems, payrollPolicy, fnfPolicy } = await assembleInput(ctx, exitRecordId);
  // The formatter goes in from here: only this layer knows whether the PDF
  // font can draw a rupee sign.
  const result = computeFnf(input, fnfPolicy, payrollPolicy, formatPdfMoney);

  return {
    lines: result.lines,
    earningsPaise: result.earningsPaise,
    deductionsPaise: result.deductionsPaise,
    netPaise: result.netPaise,
    netInWords: paiseToWords(result.netPaise),
    yearsOfService: result.yearsOfService,
    warnings: result.warnings,
    problems,
  };
}

/** Computes and persists as a DRAFT settlement. */
export async function calculateFnf(ctx: AuthContext, exitRecordId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "exit.settle", "exit");

  const existing = await prisma.fnfSettlement.findUnique({
    where: { exitRecordId },
    select: { id: true, status: true },
  });
  if (existing && existing.status !== "DRAFT" && existing.status !== "CALCULATED") {
    throw new ConflictError(
      `That settlement is already ${existing.status.toLowerCase()} and cannot be recalculated.`,
    );
  }

  const { input, problems, employeeId, payrollPolicy, fnfPolicy } = await assembleInput(ctx, exitRecordId);
  // The formatter goes in from here: only this layer knows whether the PDF
  // font can draw a rupee sign.
  const result = computeFnf(input, fnfPolicy, payrollPolicy, formatPdfMoney);

  const settlement = await prisma.$transaction(async (tx) => {
    const saved = await tx.fnfSettlement.upsert({
      where: { exitRecordId },
      create: {
        organizationId: ctx.organizationId!,
        employeeId,
        exitRecordId,
        status: "CALCULATED",
        earningsPaise: result.earningsPaise,
        deductionsPaise: result.deductionsPaise,
        netPaise: result.netPaise,
        computedAt: new Date(),
        note: problems.length > 0 ? problems.join(" ") : null,
      },
      update: {
        status: "CALCULATED",
        earningsPaise: result.earningsPaise,
        deductionsPaise: result.deductionsPaise,
        netPaise: result.netPaise,
        computedAt: new Date(),
        note: problems.length > 0 ? problems.join(" ") : null,
      },
    });

    // Lines are replaced wholesale — a recalculation is a new answer, not an
    // edit of the old one.
    await tx.fnfLine.deleteMany({ where: { settlementId: saved.id } });
    await tx.fnfLine.createMany({
      data: result.lines.map((line) => ({
        settlementId: saved.id,
        code: line.code,
        label: line.label,
        kind: line.kind,
        amountPaise: line.amountPaise,
        formula: line.formula,
        sortOrder: line.sortOrder,
      })),
    });

    return saved;
  });

  await writeAudit(ctx, {
    action: "exit.settled",
    entityType: "FnfSettlement",
    entityId: settlement.id,
    after: {
      status: "CALCULATED",
      netPaise: result.netPaise,
      yearsOfService: result.yearsOfService,
    },
  });

  return {
    id: settlement.id,
    netPaise: result.netPaise,
    warnings: result.warnings,
    problems,
  };
}

/**
 * Approves and freezes.
 *
 * The snapshot is written here and never again. After this point the figures
 * are a statement somebody has been given, not a calculation that can drift.
 */
export async function approveFnf(ctx: AuthContext, settlementId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "exit.settle", "exit");

  const settlement = await prisma.fnfSettlement.findFirst({
    where: { id: settlementId, organizationId: ctx.organizationId },
    include: { exitRecord: true, lines: true, employee: { select: { userId: true } } },
  });
  if (!settlement) throw new NotFoundError("That settlement");
  if (settlement.status !== "CALCULATED") {
    throw new ConflictError(
      settlement.status === "DRAFT"
        ? "Calculate the settlement before approving it."
        : `That settlement is already ${settlement.status.toLowerCase()}.`,
    );
  }
  if (!settlement.exitRecordId) throw new ValidationError("That settlement has no exit attached.");

  const { input, payrollPolicy, fnfPolicy } = await assembleInput(ctx, settlement.exitRecordId);

  await prisma.fnfSettlement.update({
    where: { id: settlementId },
    data: {
      status: "APPROVED",
      approvedById: ctx.userId,
      approvedAt: new Date(),
      // Everything needed to explain this figure later, frozen.
      snapshot: {
        input,
        fnfPolicy,
        payrollPolicy,
        approvedAt: new Date().toISOString(),
      } as unknown as object,
    },
  });

  await writeAudit(ctx, {
    action: "exit.settled",
    entityType: "FnfSettlement",
    entityId: settlementId,
    before: { status: "CALCULATED" },
    after: { status: "APPROVED", netPaise: settlement.netPaise },
  });

  if (settlement.employee.userId) {
    await notify.toUser(settlement.employee.userId, {
      type: "exit.settled",
      title: "Your full and final settlement is ready",
      // A notification, read on a screen that draws the rupee sign fine.
      body: `${formatPaise(settlement.netPaise)} has been approved.`,
      link: "/me/salary",
    });
  }

  return { id: settlementId, status: "APPROVED" as const };
}

export async function recordFnfPayment(
  ctx: AuthContext,
  settlementId: string,
  input: { amountPaise: number; settledOn: DateOnly },
) {
  requireOrg(ctx);
  requireWrite(ctx, "exit.settle", "exit");

  const settlement = await prisma.fnfSettlement.findFirst({
    where: { id: settlementId, organizationId: ctx.organizationId },
    select: { id: true, status: true, netPaise: true, paidPaise: true },
  });
  if (!settlement) throw new NotFoundError("That settlement");
  if (settlement.status !== "APPROVED" && settlement.status !== "PAID") {
    throw new ConflictError("Approve the settlement before recording a payment.");
  }

  const outstanding = settlement.netPaise - settlement.paidPaise;
  if (input.amountPaise > outstanding) {
    throw new ValidationError(
      // An error message on a form, not a line in a PDF.
      `That is more than the ${formatPaise(outstanding)} still outstanding.`,
    );
  }

  const paid = settlement.paidPaise + input.amountPaise;

  await prisma.fnfSettlement.update({
    where: { id: settlementId },
    data: {
      paidPaise: paid,
      settledOn: toDate(input.settledOn),
      status: paid >= settlement.netPaise ? "PAID" : "APPROVED",
    },
  });

  return { id: settlementId, paidPaise: paid, outstanding: settlement.netPaise - paid };
}

// ------------------------------------------------------------------ statement

export async function getFnfStatementPdf(ctx: AuthContext, settlementId: string) {
  requireOrg(ctx);

  const settlement = await prisma.fnfSettlement.findFirst({
    where: { id: settlementId, organizationId: ctx.organizationId },
    include: {
      lines: { orderBy: { sortOrder: "asc" } },
      exitRecord: true,
      employee: {
        select: {
          id: true,
          employeeCode: true,
          joiningDate: true,
          firstName: true,
          lastName: true,
          user: { select: { name: true } },
          designation: { select: { title: true } },
          department: { select: { name: true } },
        },
      },
    },
  });
  if (!settlement) throw new NotFoundError("That settlement");

  const own = settlement.employeeId === ctx.employeeId;
  if (own) {
    requirePermission(ctx, "payroll.read.self");
  } else if (!ctx.permissions.has("exit.settle") && !ctx.permissions.has("exit.manage")) {
    throw new NotFoundError("That settlement");
  }

  if (settlement.status === "DRAFT" || settlement.status === "CANCELLED") {
    throw new ConflictError("That settlement is not final, so no statement can be issued.");
  }

  if (settlement.fileKey && (await storage().exists(settlement.fileKey))) {
    return { url: `/api/files/${settlement.fileKey}` };
  }

  // The shared letterhead, like the letter and the payslip. This used to build
  // its own from four of the seven address fields, so the last document an
  // employer hands somebody was the one that did not look like the others.
  const header = await documentHeader(ctx.organizationId, "fnf");

  const pdf = await renderFnfPdf({
    organization: {
      name: header?.name ?? "",
      address: header?.address ?? null,
      contact: header?.contact ?? null,
      statutory: header?.statutory ?? null,
      logoDataUri: header?.logoDataUri ?? null,
    },
    employee: {
      name: employeeName(settlement.employee, "—"),
      code: settlement.employee.employeeCode,
      designation: settlement.employee.designation?.title ?? null,
      department: settlement.employee.department?.name ?? null,
      joinedOn: readableDate(
        settlement.employee.joiningDate ? toDateOnly(settlement.employee.joiningDate) : null,
      ),
      lastWorkingDay: readableDate(
        settlement.exitRecord ? toDateOnly(settlement.exitRecord.lastWorkingDay) : null,
      ),
    },
    issuedOn: readableDate(todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata")) ?? "",
    earnings: settlement.lines
      .filter((l) => l.kind === "EARNING")
      .map((l) => ({ label: l.label, amount: formatPdfMoney(l.amountPaise), formula: l.formula })),
    deductions: settlement.lines
      .filter((l) => l.kind === "DEDUCTION")
      .map((l) => ({ label: l.label, amount: formatPdfMoney(l.amountPaise), formula: l.formula })),
    totals: {
      earnings: formatPdfMoney(settlement.earningsPaise),
      deductions: formatPdfMoney(settlement.deductionsPaise),
      net: formatPdfMoney(settlement.netPaise),
      netInWords: paiseToWords(settlement.netPaise),
    },
    note: settlement.note,
  });

  const key = `org/${ctx.organizationId}/fnf/${settlement.id}.pdf`;
  await storage().put(key, pdf, "application/pdf", {
    organizationId: ctx.organizationId,
    kind: "fnf",
  });
  await prisma.fnfSettlement.update({ where: { id: settlementId }, data: { fileKey: key } });

  return { url: `/api/files/${key}` };
}
