import { z } from "zod";
import { ValidationError } from "@/lib/errors";
import { json, parseBody, route } from "@/lib/http/handler";
import { addItem, decideClaim, discardClaim, removeItem, submitClaim } from "@/services/reimbursements";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Adding an expense carries a bill, so that one action is multipart. Everything
 * else is JSON.
 */
export const PUT = route<{ id: string }>(async (request, { ctx, params }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError("Expected a multipart form.");
  }

  const amount = Number(form.get("amountPaise"));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ValidationError("Enter the amount you spent.");
  }
  const spentOn = String(form.get("spentOn") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn)) throw new ValidationError("Enter the date of the expense.");

  const upload = form.get("bill");
  let bill: { data: Buffer; fileName: string; mimeType: string } | undefined;
  if (upload instanceof File && upload.size > 0) {
    if (upload.size > MAX_BYTES) throw new ValidationError("That bill is too large. Use one under 5 MB.");
    bill = {
      data: Buffer.from(await upload.arrayBuffer()),
      fileName: upload.name || "bill",
      mimeType: upload.type || "application/octet-stream",
    };
  }

  return json(
    await addItem(
      ctx,
      params.id,
      {
        category: String(form.get("category") ?? "OTHER"),
        description: String(form.get("description") ?? "").trim() || undefined,
        spentOn,
        amountPaise: Math.round(amount),
      },
      bill,
    ),
    { status: 201 },
  );
});

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submit") }),
  // Only a draft of the caller's own; the service refuses anything else.
  z.object({ action: z.literal("discard") }),
  z.object({ action: z.literal("remove-item"), itemId: z.string().min(1) }),
  z.object({
    action: z.literal("approve"),
    approvedPaise: z.number().int().positive().optional(),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({ action: z.literal("reject"), note: z.string().trim().min(1).max(500) }),
]);

export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "submit":
      return json(await submitClaim(ctx, params.id));
    case "discard":
      return json(await discardClaim(ctx, params.id));
    case "remove-item":
      return json(await removeItem(ctx, params.id, body.itemId));
    case "approve":
      return json(
        await decideClaim(ctx, params.id, "APPROVED", {
          approvedPaise: body.approvedPaise,
          note: body.note,
        }),
      );
    case "reject":
      return json(await decideClaim(ctx, params.id, "REJECTED", { note: body.note }));
  }
});
