import { z } from "zod";
import { created, json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { issueAdvance, listAdvances } from "@/services/payroll/advances";

const querySchema = z.object({
  status: z.enum(["ACTIVE", "RECOVERED", "WRITTEN_OFF", "CANCELLED"]).optional(),
  employeeId: z.string().optional(),
});

export const GET = route(async (request, { ctx }) => {
  return json({ advances: await listAdvances(ctx, parseQuery(request, querySchema)) });
});

/**
 * The recovery *mode*, not an amount.
 *
 * How much comes off in a given month depends on that month's actual pay and the
 * minimum-net-pay floor, which only the engine knows. Storing a number here
 * would be a second opinion that disagrees the first time somebody joins
 * mid-month.
 */
const recoverySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("FULL_NEXT") }),
  z.object({ mode: z.literal("INSTALLMENTS"), installments: z.number().int().min(1).max(60) }),
  z.object({ mode: z.literal("FIXED_PER_MONTH"), amountPaise: z.number().int().min(1) }),
  z.object({ mode: z.literal("PERCENT_OF_NET"), percent: z.number().min(1).max(100) }),
]);

const createSchema = z.object({
  employeeId: z.string().min(1),
  amountPaise: z.number().int().min(1).max(100_000_000),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recovery: recoverySchema,
  reason: z.string().trim().max(200).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, createSchema);
  return created({ advance: await issueAdvance(ctx, body) });
});
