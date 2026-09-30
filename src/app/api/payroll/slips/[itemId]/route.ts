import { json, route } from "@/lib/http/handler";
import { getOrCreateSlip } from "@/services/payroll/slips";

/**
 * The slip for one payroll item, rendered on first request and cached after.
 *
 * Returns the URL rather than the bytes so the browser fetches the PDF through
 * the same authorised file route everything else uses.
 */
export const GET = route<{ itemId: string }>(async (_request, { ctx, params }) => {
  return json(await getOrCreateSlip(ctx, params.itemId));
});
