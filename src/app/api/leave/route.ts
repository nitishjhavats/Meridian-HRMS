import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { listLeaveRequests, requestLeave } from "@/services/leave";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");
const DAY_PART = z.enum(["FULL", "FIRST_HALF", "SECOND_HALF"]);

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  employeeId: z.string().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const GET = route(async (request) => {
  const ctx = await requireContext();
  const filters = parseQuery(request, querySchema);
  return json({ requests: await listLeaveRequests(ctx, filters) });
});

const createSchema = z.object({
  leaveTypeId: z.string().min(1),
  startDate: DATE,
  endDate: DATE,
  startDayPart: DAY_PART.optional(),
  endDayPart: DAY_PART.optional(),
  reason: z.string().trim().max(500).optional(),
});

export const POST = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, createSchema);
  return json(await requestLeave(ctx, body), { status: 201 });
});
