import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { listRegularisations, requestRegularisation } from "@/services/attendance/regularisation";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(),
  mine: z.coerce.boolean().optional(),
});

export const GET = route(async (request, { ctx }) => {
  const filters = parseQuery(request, querySchema);
  return json({ requests: await listRegularisations(ctx, filters) });
});

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requestedStatus: z.enum([
    "FULL_DAY", "HALF_DAY", "ABSENT", "PAID_LEAVE", "UNPAID_LEAVE", "ON_DUTY", "EXTRA_DAY",
  ]),
  checkIn: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  checkOut: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  reason: z.string().trim().min(5).max(500),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, createSchema);
  return json(await requestRegularisation(ctx, body), { status: 201 });
});
