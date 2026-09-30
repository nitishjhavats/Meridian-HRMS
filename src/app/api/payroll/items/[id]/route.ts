import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { getPayrollItem } from "@/services/payroll/runs";

export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await getPayrollItem(ctx, params.id));
});
