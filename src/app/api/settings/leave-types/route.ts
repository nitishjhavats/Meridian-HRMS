import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { listLeaveTypesForAdmin, saveLeaveType } from "@/services/leave/types";

export const GET = route(async (_request, { ctx }) => {
  return json({ types: await listLeaveTypesForAdmin(ctx) });
});

const bodySchema = z.object({
  id: z.string().min(1).optional(),
  code: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(60),
  paid: z.boolean(),
  annualAllocation: z.number().min(0).max(365),
  accrualMode: z.enum(["ANNUAL", "MONTHLY", "NONE"]),
  monthlyAccrual: z.number().min(0).max(31),
  carryForward: z.boolean(),
  maxCarryForward: z.number().min(0).max(365),
  allowHalfDay: z.boolean(),
  requiresApproval: z.boolean(),
  maxConsecutive: z.number().int().min(1).max(365).nullable(),
  noticeDays: z.number().int().min(0).max(365),
  countsAsPresent: z.boolean(),
  // Required rather than defaulted: a body that left `isWeekOff` out and had
  // it default to false would quietly un-mark the week off on the next save
  // of that type, and payroll would stop seeing its booked days as rest days.
  isWeekOff: z.boolean(),
  maxPerMonth: z.number().int().min(1).max(31).nullable(),
  active: z.boolean(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);
  return json(await saveLeaveType(ctx, body));
});
