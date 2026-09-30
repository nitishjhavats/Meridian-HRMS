import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { initiateExit, listExits } from "@/services/exit";

const querySchema = z.object({
  status: z.enum(["INITIATED", "NOTICE_PERIOD", "CLEARANCE", "SETTLED", "CANCELLED"]).optional(),
});

export const GET = route(async (request, { ctx }) => {
  return json({ exits: await listExits(ctx, parseQuery(request, querySchema)) });
});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const createSchema = z.object({
  employeeId: z.string().min(1),
  type: z.enum(["RESIGNATION", "TERMINATION", "RETIREMENT", "ABSCONDING", "END_OF_CONTRACT"]),
  resignationDate: DATE,
  lastWorkingDay: DATE,
  noticeDaysRequired: z.number().int().min(0).max(365).optional(),
  reason: z.string().trim().max(500).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, createSchema);
  return json(await initiateExit(ctx, body), { status: 201 });
});
