import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { createClaim, listClaims } from "@/services/reimbursements";

const querySchema = z.object({
  status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PAID", "CANCELLED"]).optional(),
  mine: z.coerce.boolean().optional(),
});

export const GET = route(async (request, { ctx }) => {
  return json({ claims: await listClaims(ctx, parseQuery(request, querySchema)) });
});

export const POST = route(async (request, { ctx }) => {
  const { title } = await parseBody(request, z.object({ title: z.string().trim().max(160) }));
  return json(await createClaim(ctx, title), { status: 201 });
});
