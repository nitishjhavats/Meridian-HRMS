import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { overrideDay, reviewFlaggedEvents } from "@/services/attendance/admin";

// CHECKED_IN is deliberately not offered: it is a day in progress, never a verdict an administrator hands down.
const STATUS = z.enum([
  "FULL_DAY", "HALF_DAY", "ABSENT", "WEEK_OFF", "DAY_OFF", "HOLIDAY",
  "EXTRA_DAY", "PAID_LEAVE", "UNPAID_LEAVE", "TRAINING_DAY", "ON_DUTY", "NOT_MARKED",
]);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("override"),
    employeeId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: STATUS,
    reason: z.string().trim().min(3).max(300),
  }),
  z.object({
    action: z.literal("clear-flag"),
    employeeId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  if (body.action === "clear-flag") {
    return json(await reviewFlaggedEvents(ctx, body.employeeId, body.date));
  }
  return json(await overrideDay(ctx, body));
});
