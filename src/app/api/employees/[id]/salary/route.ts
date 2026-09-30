import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import type { DateOnly } from "@/domain/date";
import { getSalaryProfile, saveSalaryProfile } from "@/services/payroll/salaryStructure";

const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD");

/**
 * `on` is the date a prospective revision would start.
 *
 * The component set and the percent base come from the payroll policy in force
 * then, not today, so the worked example the screen shows is computed from the
 * same rules that will pay it.
 */
const querySchema = z.object({ on: day.optional() });

const bodySchema = z.object({
  /** Integer paise. The UI reads and writes rupees and converts at its boundary. */
  ctcMonthlyPaise: z.number().int(),
  effectiveFrom: day,
  note: z.string().trim().max(500).optional(),
});

export const GET = route<{ id: string }>(async (request, { ctx, params }) => {
  const { on } = parseQuery(request, querySchema);
  return json(await getSalaryProfile(ctx, params.id, on as DateOnly | undefined));
});

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, bodySchema);
  return json(
    await saveSalaryProfile(ctx, params.id, {
      ctcMonthlyPaise: body.ctcMonthlyPaise,
      effectiveFrom: body.effectiveFrom as DateOnly,
      ...(body.note ? { note: body.note } : {}),
    }),
  );
});
