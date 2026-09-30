import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { setFeatureGrants } from "@/services/platform/organizations";

/** Level 1 of the two-level feature system: what the organisation may use at all. */
const bodySchema = z.object({ grants: z.record(z.string(), z.boolean()) });

export const PATCH = route<{ id: string }>(async (request, { params }) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);
  return json(await setFeatureGrants(ctx, params.id, body.grants));
});
