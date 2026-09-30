import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { assertSameTenant, requireOrg, requirePermission, requireWritable } from "@/lib/auth/guard";
import { ConflictError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { formatMoney } from "@/lib/utils";
import { monthLabel } from "@/domain/date";

/**
 * Recording salary payments.
 *
 * Salary is rarely paid in one clean transfer: it goes out in instalments, some
 * people are paid late, and a cash advance is settled separately. So a payroll
 * item accepts **many** payments and derives its status from their sum, rather
 * than carrying a single "paid" flag somebody has to remember to tick.
 *
 * Disbursement is allowed against a LOCKED run. Paying someone is not a change
 * to what they are owed — refusing it would mean unlocking payroll just to
 * record a bank transfer.
 */

export interface RecordPaymentInput {
  payrollItemId: string;
  amountPaise: number;
  paidOn: string;
  method?: string;
  reference?: string;
  remarks?: string;
}

/**
 * Settling a payslip that comes to nothing.
 *
 * A month of unpaid leave, or a joiner whose entire first month was recovered
 * against an advance, produces a net of zero -- and that row could never be
 * closed. `recordPayment` refuses an amount of zero, because an amount of zero
 * is a typo everywhere else; and any amount above zero is more than the nothing
 * outstanding, so it is refused too. The row kept its "Pay" button for ever and
 * the run never finished.
 *
 * So this is deliberately **not** a payment. No `SalaryPayment` row is written,
 * because no money moved and a bank reference for a transfer that never
 * happened is a lie in a financial record. What is written is the settlement
 * state and an audit entry naming who closed it.
 */
export async function settleZeroNet(ctx: AuthContext, payrollItemId: string) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.disburse");
  requireWritable(ctx);

  const item = await prisma.payrollItem.findUnique({
    where: { id: payrollItemId },
    select: {
      id: true,
      organizationId: true,
      payrollRunId: true,
      netPaise: true,
      paidPaise: true,
      settlement: true,
      run: { select: { status: true } },
    },
  });
  assertSameTenant(ctx, item ? { organizationId: item.organizationId } : null, "That payslip");

  if (item!.run.status === "DRAFT" || item!.run.status === "CALCULATED") {
    throw new ConflictError("Approve the payroll run before settling anything on it.");
  }

  // Narrow on purpose. This path skips the amount checks entirely, so it must
  // never be reachable for a payslip that is actually owed money.
  if (item!.netPaise !== 0) {
    throw new ConflictError("This payslip has an amount to pay. Record the payment instead.");
  }
  if (item!.settlement === "PAID") {
    throw new ConflictError("This payslip is already settled.");
  }

  await prisma.payrollItem.update({
    where: { id: item!.id },
    data: { settlement: "PAID", paidPaise: 0 },
  });

  await writeAudit(ctx, {
    action: "payroll.disbursed",
    entityType: "PayrollItem",
    entityId: item!.id,
    after: { netPaise: 0, settledWithoutPayment: true },
  });

  return { id: item!.id, settlement: "PAID" as const };
}

export async function recordPayment(ctx: AuthContext, input: RecordPaymentInput) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.disburse");
  requireWritable(ctx);

  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new ValidationError("Enter an amount greater than zero.");
  }

  const item = await prisma.payrollItem.findUnique({
    where: { id: input.payrollItemId },
    include: {
      run: { select: { status: true, periodYear: true, periodMonth: true } },
      employee: { select: { firstName: true, userId: true } },
      payments: { select: { amountPaise: true } },
    },
  });
  assertSameTenant(ctx, item ? { organizationId: item.organizationId } : null, "That payslip");

  if (item!.run.status === "DRAFT" || item!.run.status === "CALCULATED") {
    throw new ConflictError("Approve the payroll run before recording payments against it.");
  }

  const alreadyPaid = item!.payments.reduce((sum, p) => sum + p.amountPaise, 0);
  const outstanding = item!.netPaise - alreadyPaid;

  // Overpaying is almost always a typo — an extra zero, or the same transfer
  // entered twice — so it is refused with the actual figure rather than
  // silently accepted.
  if (input.amountPaise > outstanding) {
    throw new ValidationError(
      outstanding <= 0
        ? "This payslip is already fully paid."
        : `That is more than the ${formatMoney(outstanding)} still outstanding.`,
    );
  }

  const totalPaid = alreadyPaid + input.amountPaise;

  const payment = await prisma.$transaction(async (tx) => {
    const created = await tx.salaryPayment.create({
      data: {
        organizationId: ctx.organizationId!,
        payrollItemId: item!.id,
        amountPaise: input.amountPaise,
        paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
        method: input.method ?? "BANK_TRANSFER",
        reference: input.reference?.trim() || null,
        remarks: input.remarks?.trim() || null,
        createdById: ctx.userId,
      },
    });

    await tx.payrollItem.update({
      where: { id: item!.id },
      data: {
        paidPaise: totalPaid,
        settlement: totalPaid >= item!.netPaise ? "PAID" : totalPaid > 0 ? "PARTIALLY_PAID" : "UNPAID",
      },
    });

    // The run's headline totals move with it, so the dashboard stays honest.
    const runTotals = await tx.payrollItem.aggregate({
      where: { payrollRunId: item!.payrollRunId },
      _sum: { netPaise: true, paidPaise: true, grossPaise: true, deductionsPaise: true },
    });
    const net = runTotals._sum.netPaise ?? 0;
    const paid = runTotals._sum.paidPaise ?? 0;

    await tx.payrollRun.update({
      where: { id: item!.payrollRunId },
      data: {
        totals: {
          netPaise: net,
          grossPaise: runTotals._sum.grossPaise ?? 0,
          deductionsPaise: runTotals._sum.deductionsPaise ?? 0,
          paidPaise: paid,
          outstandingPaise: net - paid,
        },
      },
    });

    return created;
  });

  await writeAudit(ctx, {
    action: "payroll.disbursed",
    entityType: "PayrollItem",
    entityId: item!.id,
    after: {
      amountPaise: input.amountPaise,
      totalPaid,
      netPaise: item!.netPaise,
      reference: input.reference ?? null,
    },
  });

  if (item!.employee.userId) {
    await notify.toUser(item!.employee.userId, {
      type: "payroll.paid",
      title:
        totalPaid >= item!.netPaise
          ? `${monthLabel(item!.run.periodYear, item!.run.periodMonth)} salary paid`
          : "Part of your salary has been paid",
      body: `${formatMoney(input.amountPaise)} was recorded${
        totalPaid < item!.netPaise
          ? `. ${formatMoney(item!.netPaise - totalPaid)} is still outstanding.`
          : "."
      }`,
      link: "/me/salary",
    });
  }

  return payment;
}

/** One line of what has actually been paid against a payslip. */
export interface PaymentRow {
  id: string;
  amountPaise: number;
  paidOn: string;
  method: string;
  reference: string | null;
  remarks: string | null;
  recordedBy: string | null;
  recordedAt: string;
}

/**
 * What has been paid against one payslip, and by whom.
 *
 * Payments have been a full ledger since they were built -- many rows, a
 * derived settlement status, a delete-with-a-reason -- and no screen ever
 * listed them. So "kitna pay kiya gaya, full ya partial" could be answered by
 * one number on the row and nothing else: not when, not how, not by whom, and
 * a payment entered wrongly could not be found to correct it.
 */
export async function listPayments(
  ctx: AuthContext,
  payrollItemId: string,
): Promise<PaymentRow[]> {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.disburse");

  const rows = await prisma.salaryPayment.findMany({
    where: { payrollItemId, organizationId: ctx.organizationId },
    orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      amountPaise: true,
      paidOn: true,
      method: true,
      reference: true,
      remarks: true,
      createdAt: true,
      createdById: true,
    },
  });

  // One lookup for the names rather than a join per row; a payslip has a
  // handful of payments at most.
  const ids = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => Boolean(v)))];
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, organizationId: ctx.organizationId },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return rows.map((r) => ({
    id: r.id,
    amountPaise: r.amountPaise,
    paidOn: r.paidOn.toISOString().slice(0, 10),
    method: r.method,
    reference: r.reference,
    remarks: r.remarks,
    recordedBy: r.createdById ? (nameById.get(r.createdById) ?? null) : null,
    recordedAt: r.createdAt.toISOString(),
  }));
}

export async function deletePayment(ctx: AuthContext, paymentId: string, reason: string) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.disburse");
  requireWritable(ctx);
  if (!reason.trim()) throw new ValidationError("Give a reason for removing this payment.");

  const payment = await prisma.salaryPayment.findUnique({
    where: { id: paymentId },
    include: { item: { select: { id: true, netPaise: true, organizationId: true } } },
  });
  assertSameTenant(ctx, payment ? { organizationId: payment.organizationId } : null, "That payment");

  await prisma.$transaction(async (tx) => {
    await tx.salaryPayment.delete({ where: { id: paymentId } });

    const remaining = await tx.salaryPayment.aggregate({
      where: { payrollItemId: payment!.payrollItemId },
      _sum: { amountPaise: true },
    });
    const paid = remaining._sum.amountPaise ?? 0;

    await tx.payrollItem.update({
      where: { id: payment!.payrollItemId },
      data: {
        paidPaise: paid,
        settlement: paid >= payment!.item.netPaise ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID",
      },
    });
  });

  await writeAudit(ctx, {
    action: "payroll.disbursed",
    entityType: "SalaryPayment",
    entityId: paymentId,
    before: { amountPaise: payment!.amountPaise },
    metadata: { deleted: true, reason: reason.trim() },
  });
}

/**
 * Bank advice rows: what to hand the bank to actually move the money.
 *
 * Bank details are decrypted here and nowhere else, and only for someone who
 * already holds `payroll.disburse`.
 */
export async function getBankAdvice(ctx: AuthContext, runId: string) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.disburse");

  const { decryptOptional } = await import("@/lib/crypto/field");

  const items = await prisma.payrollItem.findMany({
    where: { payrollRunId: runId, organizationId: ctx.organizationId, settlement: { not: "PAID" } },
    include: {
      employee: {
        select: {
          employeeCode: true,
          firstName: true,
          lastName: true,
          bankNameCipher: true,
          bankAccountCipher: true,
          bankIfscCipher: true,
        },
      },
    },
    orderBy: { employee: { employeeCode: "asc" } },
  });

  return items.map((item) => ({
    employeeCode: item.employee.employeeCode,
    name: [item.employee.firstName, item.employee.lastName].filter(Boolean).join(" "),
    bankName: decryptOptional(item.employee.bankNameCipher) ?? "",
    accountNumber: decryptOptional(item.employee.bankAccountCipher) ?? "",
    ifsc: decryptOptional(item.employee.bankIfscCipher) ?? "",
    amountPaise: item.netPaise - item.paidPaise,
  }));
}

export function bankAdviceToCsv(
  rows: Awaited<ReturnType<typeof getBankAdvice>>,
): (string | number | null)[][] {
  return [
    ["Employee code", "Name", "Bank", "Account number", "IFSC", "Amount"],
    ...rows.map((r) => [
      r.employeeCode,
      r.name,
      r.bankName,
      r.accountNumber,
      r.ifsc,
      (r.amountPaise / 100).toFixed(2),
    ]),
  ];
}
