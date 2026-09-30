import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { getStatutory, saveStatutory } from "@/services/payroll/statutory";

/**
 * PF, ESI, professional tax and TDS.
 *
 * A separate endpoint from the AI rule builder deliberately: this writes only
 * the `statutory` block of the payroll policy, so an organisation can switch
 * provident fund on without a language model rewriting its overtime rules.
 */

const paise = z.number().int().min(0).max(1_000_000_000);

const bodySchema = z.object({
  providentFund: z.object({
    enabled: z.boolean(),
    employeePercent: z.number().min(0).max(100),
    wageCeilingPaise: paise,
    componentCode: z.string().trim().min(1).max(32),
  }),
  esi: z.object({
    enabled: z.boolean(),
    employeePercent: z.number().min(0).max(100),
    wageCeilingPaise: paise,
  }),
  professionalTax: z.object({
    enabled: z.boolean(),
    slabs: z.array(z.object({ uptoPaise: paise, amountPaise: paise })).max(20),
  }),
  incomeTax: z.object({ enabled: z.boolean(), monthlyFlatPaise: paise }),
});

export const GET = route(async (_request, { ctx }) => {
  return json(await getStatutory(ctx));
});

export const PUT = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);
  return json(await saveStatutory(ctx, body));
});
