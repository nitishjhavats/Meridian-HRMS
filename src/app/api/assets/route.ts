import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { createAsset, issueAsset, listAssets } from "@/services/assets";

const querySchema = z.object({
  status: z.enum(["AVAILABLE", "ASSIGNED", "IN_REPAIR", "RETIRED", "LOST"]).optional(),
  employeeId: z.string().optional(),
});

export const GET = route(async (request, { ctx }) => {
  return json({ assets: await listAssets(ctx, parseQuery(request, querySchema)) });
});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    assetTag: z.string().trim().min(2).max(40),
    name: z.string().trim().min(2).max(160),
    category: z.string().min(1).max(40),
    serialNumber: z.string().trim().max(80).optional(),
    valuePaise: z.number().int().min(0).optional(),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("issue"),
    assetId: z.string().min(1),
    employeeId: z.string().min(1),
    issuedOn: DATE,
    dueOn: DATE.optional(),
    conditionOnIssue: z.string().trim().max(300).optional(),
    note: z.string().trim().max(300).optional(),
  }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  return body.action === "create"
    ? json(await createAsset(ctx, body), { status: 201 })
    : json(await issueAsset(ctx, body), { status: 201 });
});
