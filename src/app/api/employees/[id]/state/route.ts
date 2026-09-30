import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { changeEmploymentState } from "@/services/employees/write";

/**
 * Moving somebody between employment states.
 *
 * Separate from the general update because it is not an edit: it frees or
 * consumes a seat, it is what the reporting and payroll layers read, and it
 * deserves a reason recorded against it.
 */
const schema = z.object({
  toState: z.enum([
    "TRAINING",
    "PROBATION",
    "REGULAR",
    "CONFIRMED",
    "NOTICE_PERIOD",
    "RESIGNED",
    "TERMINATED",
    "INACTIVE",
  ]),
  effectiveOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().trim().max(500).optional(),
});

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  return json({ employee: await changeEmploymentState(ctx, params.id, body) });
});
