import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { getRecognitionSetup, saveParameters } from "@/services/recognition";

const parameterSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(2).max(60),
  unit: z.enum(["RUPEES", "COUNT", "PERCENT", "HOURS", "POINTS"]),
  direction: z.enum(["HIGHER_IS_BETTER", "LOWER_IS_BETTER"]),
  weight: z.number().int().min(0).max(100),
  source: z.enum(["MANUAL", "PRESENT_DAYS", "PUNCTUALITY", "OVERTIME_HOURS", "GOALS_COMPLETED"]),
  active: z.boolean().optional(),
});

const saveSchema = z.object({
  parameters: z.array(parameterSchema).max(20),
  cooldownMonths: z.number().int().min(0).max(24).optional(),
});

export const GET = route(async (_request, { ctx }) => {
  return json(await getRecognitionSetup(ctx));
});

/**
 * The whole set, not a patch.
 *
 * "The weights must total 100" is a rule about the set, and a set saved one row
 * at a time never has to satisfy it.
 */
export const PUT = route(async (request, { ctx }) => {
  const body = await parseBody(request, saveSchema);
  return json(await saveParameters(ctx, body));
});
