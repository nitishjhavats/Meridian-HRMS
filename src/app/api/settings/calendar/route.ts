import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  getCalendar,
  saveHoliday,
  saveShift,
  saveWeeklyOffPattern,
} from "@/services/org/calendar";

/**
 * One endpoint for one screen.
 *
 * Shifts, weekly-off patterns and holidays answer the same question — what makes
 * a day a working day — and are edited together, so a discriminated union keeps
 * the dispatch explicit rather than spreading three near-identical route files.
 * Every write returns the whole calendar, because saving a pattern can move the
 * default off another one and the list has to show that.
 */

const clock = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 09:00 or 18:30");

/**
 * Shape only, deliberately.
 *
 * `validateWeeklyOffConfig` is the authority on what a valid configuration
 * *means* — weekday 0–6, a rotating rule needing weeks or a parity, an
 * occurrence between 1 and 5 — and refusing a weekday of 9 here would mean the
 * domain check never ran and its wording never reached anybody. Zod is left to
 * say only that this is an object of the right kind.
 */
const weeklyOffConfigSchema = z.object({
  type: z.enum(["FIXED", "MULTIPLE", "ROTATIONAL", "CUSTOM"]),
  days: z.array(z.number()).max(7).optional(),
  rotating: z
    .array(
      z.object({
        day: z.number(),
        weeks: z.array(z.number()).max(5).optional(),
        isoParity: z.enum(["ODD", "EVEN"]).optional(),
      }),
    )
    .max(7)
    .optional(),
  dates: z.array(z.string()).max(366).optional(),
});

const bodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("shift"),
    id: z.string().optional(),
    name: z.string().trim().min(2).max(80),
    startTime: clock,
    endTime: clock,
    breakMinutes: z.number().int().min(0).max(480),
    graceMinutes: z.number().int().min(0).max(240).optional(),
    crossesMidnight: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("pattern"),
    id: z.string().optional(),
    name: z.string().trim().min(2).max(80),
    config: weeklyOffConfigSchema,
    isDefault: z.boolean().optional(),
    active: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("holiday"),
    id: z.string().optional(),
    name: z.string().trim().min(2).max(80),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD"),
    type: z.enum(["PUBLIC", "ORGANISATION", "OPTIONAL", "REGIONAL"]).optional(),
    paid: z.boolean().optional(),
    optional: z.boolean().optional(),
    note: z.string().trim().max(200).optional(),
  }),
]);

export const GET = route(async (_request, { ctx }) => {
  return json(await getCalendar(ctx));
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);

  switch (body.kind) {
    case "shift":
      await saveShift(ctx, body);
      break;
    case "pattern":
      await saveWeeklyOffPattern(ctx, body);
      break;
    case "holiday":
      await saveHoliday(ctx, body);
      break;
  }

  return json(await getCalendar(ctx));
});
