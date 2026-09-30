import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { verifyOwnMarkWithPin } from "@/services/attendance/review";

const bodySchema = z.object({
  eventId: z.string().min(1),
  code: z.string().trim().regex(/^\d{4,8}$/, "A PIN is six digits."),
});

/**
 * An employee clearing their own unverified mark with a code read out to them.
 *
 * No permission beyond having an employee record: the service scopes the lookup
 * to `ctx.employeeId`, so the only mark this can ever confirm is their own.
 */
export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);
  return json(await verifyOwnMarkWithPin(ctx, body));
});
