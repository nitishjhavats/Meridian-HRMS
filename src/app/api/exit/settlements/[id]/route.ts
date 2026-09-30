import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { approveFnf, getFnfStatementPdf, recordFnfPayment } from "@/services/exit/fnf";

/** The statement PDF, rendered on first request and cached after. */
export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await getFnfStatementPdf(ctx, params.id));
});

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({
    action: z.literal("pay"),
    amountPaise: z.number().int().positive(),
    settledOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  return body.action === "approve"
    ? json(await approveFnf(ctx, params.id))
    : json(await recordFnfPayment(ctx, params.id, body));
});
