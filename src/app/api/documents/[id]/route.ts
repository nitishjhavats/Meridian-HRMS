import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { requestDeletion, verifyDocument } from "@/services/documents";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verify"), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal("request-deletion"), reason: z.string().trim().max(500).optional() }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);

  switch (body.action) {
    case "verify":
      return json(await verifyDocument(ctx, params.id, "VERIFIED", body.note));
    case "reject":
      return json(await verifyDocument(ctx, params.id, "REJECTED", body.note));
    case "request-deletion":
      return json(await requestDeletion(ctx, params.id, body.reason), { status: 201 });
  }
});
