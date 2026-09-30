import { requireContext } from "@/lib/auth/context";
import { requireOrg, requirePermission } from "@/lib/auth/guard";
import { route } from "@/lib/http/handler";
import { documentHeader } from "@/lib/pdf/orgHeader";
import { renderPayslipPdf } from "@/lib/pdf/payslip";
import { paiseToWords } from "@/domain/money";
import { formatPdfMoney } from "@/lib/pdf/fonts";
import { MONTH_NAMES } from "@/domain/date";

/**
 * A payslip with made-up figures, so an administrator can see what one looks
 * like before anybody is paid.
 *
 * The payslip sits with the letter templates because that is where somebody
 * goes to ask "what do the documents we send out look like?" — but it is not a
 * template. `renderPayslipPdf` takes a structured layout with the arithmetic
 * already done, so there is no body to edit and no placeholders to fill. What
 * *is* the organisation's to change — the name, address and logo in the header
 * — is edited on the organisation settings screen, and this shows the result.
 *
 * The numbers are deliberately obvious round figures. A sample payslip carrying
 * plausible ones invites somebody to read it as real.
 */
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const ctx = await requireContext();
  requireOrg(ctx);
  requirePermission(ctx, "payroll.read.all");

  /**
   * The same letterhead a real payslip carries.
   *
   * This built its own from five of the seven address fields, with no country,
   * no contact line and no statutory identifiers -- so the sample somebody
   * checks their letterhead against was not the letterhead. A preview whose
   * whole job is "this is what it will look like" has to be the same builder.
   */
  const header = await documentHeader(ctx.organizationId, "payslip");

  const now = new Date();
  const month = now.getUTCMonth() === 0 ? 12 : now.getUTCMonth();
  const year = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();

  const basic = 30_000_00;
  const hra = 12_000_00;
  const allowance = 8_000_00;
  const pf = 1_800_00;
  const tax = 2_500_00;
  const gross = basic + hra + allowance;
  const deductions = pf + tax;

  const pdf = await renderPayslipPdf({
    organization: {
      name: header?.name ?? "Your organisation",
      address: header?.address ?? null,
      contact: header?.contact ?? null,
      statutory: header?.statutory ?? null,
      logoDataUri: header?.logoDataUri ?? null,
    },
    slipNumber: "SAMPLE/0000",
    periodLabel: `${MONTH_NAMES[month - 1]} ${year}`,
    employee: {
      name: "Sample Employee",
      code: "SAMPLE",
      designation: "Software Engineer",
      department: "Engineering",
      joiningDate: "1 April 2024",
      bankAccount: "••••1234",
      pan: "••••1234F",
    },
    net: {
      amount: formatPdfMoney(gross - deductions),
      inWords: paiseToWords(gross - deductions),
    },
    earnings: [
      { label: "Basic", amount: formatPdfMoney(basic) },
      { label: "House rent allowance", amount: formatPdfMoney(hra) },
      { label: "Special allowance", amount: formatPdfMoney(allowance) },
    ],
    deductions: [
      { label: "Provident fund", amount: formatPdfMoney(pf) },
      { label: "Income tax", amount: formatPdfMoney(tax) },
    ],
    totals: { gross: formatPdfMoney(gross), deductions: formatPdfMoney(deductions) },
    attendance: [
      { label: "Payable days", value: "30" },
      { label: "Days worked", value: "26" },
      { label: "Weekly offs", value: "4" },
      { label: "Leave taken", value: "0" },
    ],
    notes: ["This is a sample. The figures are illustrative and nobody has been paid them."],
  });

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="sample-payslip.pdf"',
      // Never cached: the header changes the moment the logo or address does.
      "Cache-Control": "no-store",
    },
  });
});
