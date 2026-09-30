import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission } from "@/lib/auth/guard";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { buildPeriodCalendar } from "@/domain/calendar";
import { MONTH_NAMES, endOfMonth, parts, startOfMonth, todayInZone } from "@/domain/date";
import { paiseToWords } from "@/domain/money";
import { sampleMonthInput } from "@/domain/payroll/sample";
import { simulatePayroll } from "@/domain/payroll/simulate";
import type { LineItem } from "@/domain/payroll/types";
import { decryptOptional, maskTail } from "@/lib/crypto/field";
import { formatPdfMoney, toPdfSafeText } from "@/lib/pdf/fonts";
import { documentHeader } from "@/lib/pdf/orgHeader";
import { renderPayslipPdf, type PayslipLine } from "@/lib/pdf/payslip";
import { resolveWeeklyOff } from "@/services/org/weeklyOff";
import { weekOffQuotaFor } from "@/services/payroll/inputBuilder";
import { getPayrollPolicy } from "@/services/policy";

/**
 * A sample payslip an employee can open for themselves, before they have ever
 * been paid.
 *
 * "My salary" showed a dead end: "No payslips yet", and nothing else, for
 * however many weeks stood between somebody's first day and their first
 * approved run. The only sample in the product was the administrator's, gated on
 * `payroll.read.all` and built from hard-coded round figures — ₹30,000 basic for
 * a person earning anything at all.
 *
 * This one is theirs. Their CTC as recorded, their organisation's salary
 * structure and payroll policy, their own weekly-off pattern, run through
 * `simulatePayroll` — the same engine that will pay them. So the answer to "what
 * will I actually take home" is the real answer, and the details block doubles
 * as a check: somebody can see that their bank account or PAN is wrong on their
 * payslip *before* payday rather than after it.
 *
 * ## The permission boundary
 *
 * The employee is `ctx.employeeId` and there is deliberately **no parameter**.
 * Not an id, not a code, not an "as of" employee — nothing a caller could put
 * on a URL. Everything else in this file is scoped by `ctx.organizationId` as
 * well, but the boundary that matters here is the missing argument: a sample
 * payslip that took an id would be an endpoint any employee could point at any
 * colleague to read their salary, and no amount of checking further down makes
 * that as safe as not accepting it. `samplePayslip.test.ts` pins it.
 *
 * ## Nothing is stored
 *
 * No `SalarySlip` row, no file in storage, no audit entry. A real slip is
 * cached because a locked run's figures never change; this one changes the
 * moment somebody's salary or the policy does, and it is not a record of
 * anything — it is a rendering of what the rules currently say.
 */

/** The word across the page. One constant, so the test and the render agree. */
export const SAMPLE_WATERMARK = "DEMO";

/**
 * "13 April 2023" — a date a person reads, not an ISO string.
 *
 * The third copy of these three lines (`slips.ts`, `exit/fnf.ts`). Left as a
 * copy on purpose: pulling it into a shared module means editing two files that
 * issue money documents, for a formatter, and that is not a trade worth making
 * inside this change.
 */
function formatDocumentDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${d} ${MONTH_NAMES[(m ?? 1) - 1]} ${y}`;
}

/** The same mapping a real payslip uses, so the two cannot disagree in shape. */
function lines(items: readonly LineItem[]): PayslipLine[] {
  return items.map((item) => ({
    label: item.label,
    amount: formatPdfMoney(item.amountPaise),
  }));
}

export interface SamplePayslip {
  pdf: Buffer;
  slipNumber: string;
  periodLabel: string;
}

export async function renderMySamplePayslip(ctx: AuthContext): Promise<SamplePayslip> {
  requireOrg(ctx);
  // The permission for seeing your own pay. `payroll.read.all` is not accepted
  // as a substitute anywhere here, because there is nobody else to read.
  requirePermission(ctx, "payroll.read.self");
  requireModule(ctx, "payroll");

  const employeeId = ctx.employeeId;
  if (!employeeId) {
    throw new ForbiddenError("Your login is not linked to an employee record.");
  }

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId: ctx.organizationId },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      joiningDate: true,
      departmentId: true,
      bankAccountCipher: true,
      panCipher: true,
      uanCipher: true,
      pfNumberCipher: true,
      user: { select: { name: true } },
      weekOffsPerMonth: true,
      designation: { select: { title: true, weekOffsPerMonth: true } },
      department: { select: { name: true } },
      weeklyOffConfig: true,
      weeklyOffPattern: { select: { config: true } },
    },
  });
  if (!employee) throw new NotFoundError("Your employee record");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const { year, month } = parts(today);

  /**
   * The salary revision in force today.
   *
   * Read the way `inputBuilder.ts` reads it — latest `effectiveFrom` on or
   * before the date, no `effectiveTo` filter — so this cannot say "nothing on
   * record" about a person payroll would happily pay. `organizationId` as well
   * as `employeeId` on a money table, per the house rule.
   */
  const profile = await prisma.salaryProfile.findFirst({
    where: {
      organizationId: ctx.organizationId,
      employeeId,
      effectiveFrom: { lte: new Date(`${today}T00:00:00.000Z`) },
    },
    orderBy: { effectiveFrom: "desc" },
    select: { ctcMonthlyPaise: true },
  });

  /**
   * With no salary on record, the sample is built on a stated example figure.
   *
   * This used to refuse, and the screen hid the button when it would have --
   * which is why nobody on this instance had ever seen a sample payslip: not
   * one employee in the production database has a `SalaryProfile`, so the
   * control was hidden for every single person the feature was written for.
   *
   * A page of ₹0.00 rows would be worse than a refusal, because it looks like a
   * real statement of what somebody is owed. An example figure is neither: the
   * page carries the DEMO watermark it always did, and a line saying in plain
   * words that the salary is an example because HR has not recorded one. The
   * rest -- their name, their code, their weekly offs, the organisation's own
   * payroll rules, their masked bank tail -- is all real, which is what makes
   * the sample worth opening at all.
   */
  const EXAMPLE_CTC_PAISE = 3_000_000; // ₹30,000 a month, written once.
  const ctcMonthlyPaise = profile?.ctcMonthlyPaise ?? EXAMPLE_CTC_PAISE;
  const ctcIsExample = profile === null;

  const [{ policy }, header, weeklyOff] = await Promise.all([
    // Needs no special permission: it is the organisation's own rule set, and
    // the figures below are meaningless without it.
    getPayrollPolicy(ctx, today),
    documentHeader(ctx.organizationId, "payslip"),
    resolveWeeklyOff(prisma, ctx.organizationId, employee),
  ]);

  /**
   * The employee's own rest days for this month.
   *
   * No holidays are passed. A holiday is paid either way, so it cannot change
   * the net — and a sample whose day counts depend on which festivals happened
   * to fall this month is harder to read than one that does not. Rest days are
   * different: an organisation on a five-day week would otherwise be handed a
   * payslip claiming 26 days worked in a 31-day month.
   */
  const calendar = buildPeriodCalendar(
    startOfMonth(year, month),
    endOfMonth(year, month),
    {
      employeeId,
      departmentId: employee.departmentId,
      region: null,
      weeklyOff,
    },
    [],
  );

  const { result } = simulatePayroll(
    {
      ...sampleMonthInput(ctcMonthlyPaise, today, {
        totalDays: calendar.totalDays,
        weekOffDays: calendar.weekOffDays,
      }),
      // The same three layers a real run reads: theirs, their designation's,
      // then the rule. A clean month never works a rest day, so nothing is
      // credited here — but the sample and the payslip resolve the quota the
      // same way, which is the promise the sample makes.
      weekOffQuota: weekOffQuotaFor(employee),
    },
    policy,
  );

  const periodLabel = `${MONTH_NAMES[month - 1]} ${year}`;
  // Never "SLIP/". The number is printed in the footer of every page, so it has
  // to say what the document is even where the watermark has been cropped off.
  const slipNumber = `SAMPLE/${year}${String(month).padStart(2, "0")}/${employee.employeeCode}`;

  const bank = decryptOptional(employee.bankAccountCipher);

  const pdf = await renderPayslipPdf({
    organization: {
      name: header?.name ?? "",
      address: header?.address ?? null,
      contact: header?.contact ?? null,
      statutory: header?.statutory ?? null,
      logoDataUri: header?.logoDataUri ?? null,
    },
    watermark: SAMPLE_WATERMARK,
    slipNumber,
    periodLabel,
    employee: {
      // Off the employee record, not off a login — the same reason `slips.ts`
      // gives: plenty of people created by the bulk importer have no login.
      name:
        [employee.firstName, employee.lastName].filter(Boolean).join(" ") ||
        employee.user?.name ||
        "—",
      code: employee.employeeCode,
      designation: employee.designation?.title ?? null,
      department: employee.department?.name ?? null,
      joiningDate: formatDocumentDate(employee.joiningDate.toISOString().slice(0, 10)),
      // Their own identifiers, on their own document. This is half the value of
      // the sample: a wrong account number found today costs a conversation,
      // found on payday it costs a missed salary.
      bankAccount: bank ? maskTail(bank, 4) : null,
      pan: decryptOptional(employee.panCipher),
      uan: decryptOptional(employee.uanCipher),
      pfNumber: decryptOptional(employee.pfNumberCipher),
    },
    net: { amount: formatPdfMoney(result.netPaise), inWords: paiseToWords(result.netPaise) },
    earnings: lines(result.earnings),
    deductions: lines(result.deductions),
    totals: {
      gross: formatPdfMoney(result.grossPaise),
      deductions: formatPdfMoney(result.totalDeductionsPaise + result.advanceRecoveredPaise),
    },
    attendance: [
      { label: "Payable", value: String(result.days.payableDays) },
      { label: "Of", value: String(result.days.basisDays) },
      { label: "Present", value: String(result.days.presentDays) },
      { label: "Paid leave", value: String(result.days.paidLeaveDays) },
      { label: "Unpaid", value: String(result.days.unpaidLeaveDays) },
      { label: "Absent", value: String(result.days.absentDays) },
      { label: "Half days", value: String(result.days.halfDays) },
      { label: "Week offs", value: String(result.days.weekOffDays) },
      { label: "Holidays", value: String(result.days.holidayDays) },
      { label: "Extra days", value: String(result.days.extraDays) },
      { label: "Late", value: String(result.days.lateCount) },
      { label: "Overtime", value: `${Math.round(result.days.overtimeMinutes / 6) / 10}h` },
    ],
    notes: [
      ctcIsExample
        ? "This is a sample, and the salary on it is an example figure: HR has not recorded a salary for you yet. Everything else — your details, your weekly offs, this organisation's payroll rules — is real. Nobody has been paid these figures."
        : "This is a sample. It is worked out from your salary as recorded today and a full month with no absences, using the same rules that calculate real payroll — nobody has been paid these figures.",
      // The engine writes warnings with the domain formatter, whose rupee sign
      // draws as a superscript one in a PDF without the embedded font.
      ...result.warnings.map((warning) => toPdfSafeText(warning)),
    ],
    footerNote: `${header?.name ?? ""} · ${slipNumber} · Sample, not a statement of pay`,
  });

  return { pdf, slipNumber, periodLabel };
}
