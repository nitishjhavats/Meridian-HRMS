import { json, route } from "@/lib/http/handler";
import { generateRunSlips } from "@/services/payroll/slips";

/** Generates every slip for an approved run, in series. */
export const POST = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await generateRunSlips(ctx, params.id));
});
