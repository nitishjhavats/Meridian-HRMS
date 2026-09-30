import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { getSalaryComponents, saveSalaryComponent } from "@/services/payroll/salaryStructure";

/**
 * The salary component catalogue.
 *
 * Shape only. What a structure *means* — percentages totalling 100 %, one
 * balance component at most, no circular references — is
 * `validateSalaryStructure`'s job, and refusing a 140 % component here would
 * mean the domain check never ran and its wording never reached anybody.
 */
const calcSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("PERCENT_OF_CTC"), percent: z.number() }),
  z.object({
    type: z.literal("PERCENT_OF_COMPONENT"),
    of: z.string().trim().min(1).max(32),
    percent: z.number(),
  }),
  z.object({ type: z.literal("FIXED"), amountPaise: z.number().int() }),
  z.object({ type: z.literal("BALANCE") }),
]);

const bodySchema = z.object({
  id: z.string().min(1).optional(),
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(64),
  kind: z.enum(["EARNING", "DEDUCTION"]),
  calc: calcSchema,
  prorated: z.boolean().optional(),
  taxable: z.boolean().optional(),
  showOnSlip: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  active: z.boolean().optional(),
});

export const GET = route(async (_request, { ctx }) => {
  return json(await getSalaryComponents(ctx));
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);
  // The whole snapshot comes back: saving one component republishes the payroll
  // policy, and the divergence notice on the screen has to reflect that.
  return json(await saveSalaryComponent(ctx, body));
});
