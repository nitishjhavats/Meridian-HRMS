import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { previewLeave } from "@/services/leave";

/**
 * What a request would cost, without creating it.
 *
 * The form calls this as dates change so the day count and any problem appear
 * before somebody commits — the alternative is submitting and being told no.
 */
const schema = z.object({
  leaveTypeId: z.string().min(1),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startDayPart: z.enum(["FULL", "FIRST_HALF", "SECOND_HALF"]).optional(),
  endDayPart: z.enum(["FULL", "FIRST_HALF", "SECOND_HALF"]).optional(),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, schema);
  return json({ preview: await previewLeave(ctx, body) });
});
