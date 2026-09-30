import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { setOrganizationStatus } from "@/services/platform/organizations";

const bodySchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED", "PENDING_PAYMENT"]),
  reason: z.string().trim().max(500).optional(),
});

export const POST = route<{ id: string }>(async (request, { params }) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);
  return json({ organization: await setOrganizationStatus(ctx, params.id, body.status, body.reason) });
});
