import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { getMonthlyEntry, saveMonthlyValues } from "@/services/recognition";

const periodSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

const saveSchema = periodSchema.extend({
  values: z
    .array(
      z.object({
        employeeId: z.string().min(1),
        parameterId: z.string().min(1),
        // null clears the figure. That is not the same as typing a zero, and the
        // difference decides whether somebody is named as missing a value.
        rawValue: z.number().finite().nullable(),
      }),
    )
    .min(1)
    .max(2000),
});

export const GET = route(async (request, { ctx }) => {
  const { year, month } = parseQuery(request, periodSchema);
  return json(await getMonthlyEntry(ctx, year, month));
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, saveSchema);
  return json(await saveMonthlyValues(ctx, body));
});
