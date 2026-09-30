import { z } from "zod";
import { created, parseBody, route } from "@/lib/http/handler";
import { issueAttendancePin } from "@/services/attendance/kiosk";

const bodySchema = z.object({ reason: z.string().trim().max(120).optional() });

/**
 * A one-time PIN for somebody whose face will not match at the office device.
 *
 * The code is in the response and nowhere else: it is read out to the person and
 * spent within fifteen minutes. Only a hash is stored.
 */
export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  return created(await issueAttendancePin(ctx, params.id, body.reason));
});
