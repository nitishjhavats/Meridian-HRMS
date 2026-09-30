import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission } from "@/lib/auth/guard";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { storage } from "@/lib/storage";
import { paiseToWords } from "@/domain/money";
import { formatPdfMoney, toPdfSafeText } from "@/lib/pdf/fonts";
import { MONTH_NAMES } from "@/domain/date";
import { documentHeader } from "@/lib/pdf/orgHeader";
import { DEFAULT_CODE_PREFIX, normaliseCodePrefix } from "@/domain/employees/code";
import { renderPayslipPdf, type PayslipLine } from "@/lib/pdf/payslip";
import { decryptOptional, maskTail } from "@/lib/crypto/field";

/**
 * Salary slips.
 *
 * A slip is generated from a payroll item and cached, because the figures for a
 * given run never change — a locked run is immutable, and reopening one creates
 * a new revision rather than editing the old. So the first request renders and
 * stores; every later one serves the stored file.
 *
 * Slips are only available once a run is approved. A draft calculation is a
 * working number, and handing someone a payslip for a figure still being argued
 * about creates a conversation nobody wanted.
 */

/** "13 April 2023" — a date a person reads, not an ISO string. */
function formatDocumentDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;
}

const ISSUABLE_STATUSES = ["APPROVED", "LOCKED"] as const;

interface EarningLine {
  code?: string;
  label?: string;
  amountPaise?: number;
}

function lines(value: unknown): PayslipLine[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const line = raw as EarningLine;
      if (typeof line.amountPaise !== "number") return null;
      return { label: line.label ?? line.code ?? "—", amount: formatPdfMoney(line.amountPaise) };
    })
    .filter((l): l is PayslipLine => l !== null);
}

/**
 * The organisation's mark, then the period, then who it is for.
 *
 * `SLIP/202609/JVNK001` already identified the company, through the employee
 * code -- but it did so at the end, and every other number this organisation
 * issues now leads with its mark. Leading with it is what makes the family
 * legible: a person holding JVNK/SLIP, JVNK/OFR and JVNK/EXP can see they came
 * from the same place.
 *
 * The mark is not printed twice. An employee code that already begins with it
 * contributes only its serial, so this reads `JVNK/SLIP/202609/001` rather than
 * `JVNK/SLIP/202609/JVNK001`. A code from an older prefix keeps its whole self,
 * because the serial alone would be ambiguous between the two series.
 *
 * Numbers already generated are stored on the slip row and are read from there;
 * only slips made from now on take this shape.
 */
function slipNumberFor(mark: string, year: number, month: number, code: string): string {
  const upper = code.trim().toUpperCase();
  const tail = upper.startsWith(mark) ? upper.slice(mark.length) : upper;
  return `${mark}/SLIP/${year}${String(month).padStart(2, "0")}/${tail || upper}`;
}

/**
 * Generates the slip if it does not exist, and returns where to find it.
 *
 * Anyone may fetch their own; fetching somebody else's needs the
 * organisation-wide payroll read permission.
 */
export async function getOrCreateSlip(ctx: AuthContext, payrollItemId: string) {
  requireOrg(ctx);

  const item = await prisma.payrollItem.findFirst({
    where: { id: payrollItemId, organizationId: ctx.organizationId },
    include: {
      slip: true,
      run: { select: { periodYear: true, periodMonth: true, status: true, revision: true } },
      employee: {
        select: {
          id: true,
          employeeCode: true,
          joiningDate: true,
          firstName: true,
          lastName: true,
          bankAccountCipher: true,
          panCipher: true,
          uanCipher: true,
          pfNumberCipher: true,
          user: { select: { name: true } },
          designation: { select: { title: true } },
          department: { select: { name: true } },
        },
      },
    },
  });
  if (!item) throw new NotFoundError("That salary slip");

  const own = item.employeeId === ctx.employeeId;
  if (own) {
    requirePermission(ctx, "payroll.read.self");
  } else if (!ctx.permissions.has("payroll.read.all")) {
    // Not "forbidden" — someone else's payslip should not even be known to exist.
    throw new NotFoundError("That salary slip");
  }

  if (!ISSUABLE_STATUSES.includes(item.run.status as (typeof ISSUABLE_STATUSES)[number])) {
    throw new ConflictError(
      "That payroll run has not been approved yet, so no salary slip is available.",
    );
  }

  // Already rendered and still on disk: serve it.
  if (item.slip?.fileKey && (await storage().exists(item.slip.fileKey))) {
    return { slipNumber: item.slip.slipNumber, url: `/api/files/${item.slip.fileKey}` };
  }

  // One letterhead for letters, payslips and settlements. This used to compose
  // its own address from five of the seven fields -- no country -- and never
  // fetched a phone number, a website or a single statutory identifier.
  const header = await documentHeader(ctx.organizationId, "payslip");

  const periodLabel = `${MONTH_NAMES[item.run.periodMonth - 1]} ${item.run.periodYear}`;
  const slipNumber =
    item.slip?.slipNumber ??
    slipNumberFor(
      normaliseCodePrefix(header?.codePrefix ?? DEFAULT_CODE_PREFIX),
      item.run.periodYear,
      item.run.periodMonth,
      item.employee.employeeCode,
    );

  // Only the last four digits of an account number go on a payslip: enough to
  // confirm which account was paid, useless to anyone who picks the paper up.
  const bank = decryptOptional(item.employee.bankAccountCipher);

  const pdf = await renderPayslipPdf({
    organization: {
      name: header?.name ?? "",
      address: header?.address ?? null,
      contact: header?.contact ?? null,
      statutory: header?.statutory ?? null,
      logoDataUri: header?.logoDataUri ?? null,
    },
    slipNumber,
    periodLabel,
    employee: {
      // Off the employee record, not off a login. Reading it from `user` is
      // what put an em dash where somebody's name should be on their own
      // payslip -- and the bulk importer creates plenty of people with no
      // login at all.
      name:
        [item.employee.firstName, item.employee.lastName].filter(Boolean).join(" ") ||
        item.employee.user?.name ||
        "—",
      code: item.employee.employeeCode,
      designation: item.employee.designation?.title ?? null,
      department: item.employee.department?.name ?? null,
      joiningDate: item.employee.joiningDate
        ? formatDocumentDate(item.employee.joiningDate.toISOString().slice(0, 10))
        : null,
      bankAccount: bank ? maskTail(bank, 4) : null,
      // Encrypted at rest; the last four are what a payslip is for. PAN was in
      // the renderer's type from the day it was written and never passed.
      pan: decryptOptional(item.employee.panCipher),
      uan: decryptOptional(item.employee.uanCipher),
      pfNumber: decryptOptional(item.employee.pfNumberCipher),
    },
    net: { amount: formatPdfMoney(item.netPaise), inWords: paiseToWords(item.netPaise) },
    earnings: lines(item.earnings),
    deductions: lines(item.deductions),
    totals: {
      gross: formatPdfMoney(item.grossPaise),
      deductions: formatPdfMoney(item.deductionsPaise + item.advanceRecoveredPaise),
    },
    attendance: [
      { label: "Payable", value: String(Number(item.payableDays)) },
      { label: "Of", value: String(Number(item.basisDays)) },
      { label: "Present", value: String(Number(item.presentDays)) },
      { label: "Paid leave", value: String(Number(item.paidLeaveDays)) },
      { label: "Unpaid", value: String(Number(item.unpaidLeaveDays)) },
      { label: "Absent", value: String(Number(item.absentDays)) },
      { label: "Half days", value: String(Number(item.halfDays)) },
      { label: "Week offs", value: String(Number(item.weekOffDays)) },
      { label: "Holidays", value: String(Number(item.holidayDays)) },
      { label: "Extra days", value: String(Number(item.extraDays)) },
      { label: "Late", value: String(item.lateCount) },
      { label: "Overtime", value: `${Math.round(item.overtimeMinutes / 6) / 10}h` },
    ],
    notes: [
      // The engine writes these with the domain formatter, which uses a real
      // rupee sign -- correct for the screen, and a superscript one in a PDF
      // drawn without the embedded font. Sanitised here, at the boundary,
      // rather than asking whoever writes the next warning to know that.
      ...item.warnings.map((warning) => toPdfSafeText(warning)),
      ...(item.run.revision > 1 ? [`This is revision ${item.run.revision} of this month's payroll.`] : []),
    ],
  });

  const key = `org/${ctx.organizationId}/payslips/${slipNumber.replace(/\//g, "-")}.pdf`;
  await storage().put(key, pdf, "application/pdf", {
    organizationId: ctx.organizationId,
    kind: "payslips",
  });

  await prisma.salarySlip.upsert({
    where: { payrollItemId },
    create: {
      organizationId: ctx.organizationId,
      payrollItemId,
      slipNumber,
      fileKey: key,
      generatedById: ctx.userId,
    },
    update: { fileKey: key, generatedAt: new Date(), generatedById: ctx.userId },
  });

  await writeAudit(ctx, {
    action: "payroll.disbursed",
    entityType: "SalarySlip",
    entityId: payrollItemId,
    metadata: { slipNumber, period: periodLabel, sizeBytes: pdf.length, own },
  });

  return { slipNumber, url: `/api/files/${key}` };
}

/**
 * Generates every slip for an approved run.
 *
 * Done in series rather than in parallel: rendering a PDF is CPU-bound, and
 * twenty at once would stall the request handler for everyone else.
 */
export async function generateRunSlips(ctx: AuthContext, runId: string) {
  requireOrg(ctx);
  requirePermission(ctx, "payroll.read.all");

  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, organizationId: ctx.organizationId },
    select: { id: true, status: true, items: { select: { id: true } } },
  });
  if (!run) throw new NotFoundError("That payroll run");
  if (!ISSUABLE_STATUSES.includes(run.status as (typeof ISSUABLE_STATUSES)[number])) {
    throw new ConflictError("Approve the run before generating salary slips.");
  }

  let generated = 0;
  for (const item of run.items) {
    await getOrCreateSlip(ctx, item.id);
    generated++;
  }

  return { generated };
}
