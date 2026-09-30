import { z } from "zod";
import { json, parseQuery, route } from "@/lib/http/handler";
import { getKioskMonth } from "@/services/attendance/kiosk";

/**
 * One person's month, for the reception screen.
 *
 * Separate from `/api/attendance/month` because a device holds no read
 * permission at all — widening the KIOSK role to reach that route would give a
 * screen bolted to a wall the whole organisation's attendance. This is scoped
 * to the device's own roster, which is the set of people it can already mark.
 */
export const GET = route(async (request, { ctx }) => {
  const params = parseQuery(
    request,
    z.object({
      employeeId: z.string().min(1),
      year: z.coerce.number().int().min(2000).max(2100),
      month: z.coerce.number().int().min(1).max(12),
    }),
  );
  return json(await getKioskMonth(ctx, params));
});
