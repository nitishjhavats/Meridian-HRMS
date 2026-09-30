import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { acknowledgeAssignment, returnAsset, setAssetStatus } from "@/services/assets";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("return"),
    assignmentId: z.string().min(1),
    returnedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    conditionOnReturn: z.string().trim().max(300).optional(),
    recoveryPaise: z.number().int().min(0).optional(),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({
    action: z.literal("status"),
    status: z.enum(["AVAILABLE", "ASSIGNED", "IN_REPAIR", "RETIRED", "LOST"]),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({ action: z.literal("acknowledge"), assignmentId: z.string().min(1) }),
]);

/** `id` is the asset; return and acknowledge address the assignment inside it. */
export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "return":
      return json(await returnAsset(ctx, body.assignmentId, body));
    case "status":
      return json(await setAssetStatus(ctx, params.id, body.status, body.note));
    case "acknowledge":
      return json(await acknowledgeAssignment(ctx, body.assignmentId));
  }
});
