import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { created, json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { createRun, listRuns } from "@/services/payroll/runs";

const querySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });

export const GET = route(async (request) => {
  const ctx = await requireContext();
  const { year } = parseQuery(request, querySchema);
  return json({ runs: await listRuns(ctx, year) });
});

const createSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, createSchema);
  return created({ run: await createRun(ctx, body.year, body.month) });
});
