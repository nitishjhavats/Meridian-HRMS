import { requireContext } from "@/lib/auth/context";
import { csvResponse, route } from "@/lib/http/handler";
import { bankAdviceToCsv, getBankAdvice } from "@/services/payroll/disbursement";

/** Bank transfer file for what is still unpaid on this run. */
export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  const rows = await getBankAdvice(ctx, params.id);
  const stamp = new Date().toISOString().slice(0, 10);
  return csvResponse(`bank-advice-${stamp}.csv`, bankAdviceToCsv(rows));
});
