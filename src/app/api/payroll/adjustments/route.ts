import { z } from "zod";
import { created, json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { addAdjustment, listAdjustments } from "@/services/payroll/adjustments";

const querySchema = z.object({
  runId: z.string().min(1),
  employeeId: z.string().min(1),
});

export const GET = route(async (request, { ctx }) => {
  const { runId, employeeId } = parseQuery(request, querySchema);
  return json({ adjustments: await listAdjustments(ctx, runId, employeeId) });
});

const createSchema = z.object({
  payrollRunId: z.string().min(1),
  employeeId: z.string().min(1),
  label: z.string().trim().min(2).max(60),
  kind: z.enum(["EARNING", "DEDUCTION"]),
  amountPaise: z.number().int().min(1).max(100_000_000),
  reason: z.string().trim().max(200).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, createSchema);
  return created({ adjustment: await addAdjustment(ctx, body) });
});
