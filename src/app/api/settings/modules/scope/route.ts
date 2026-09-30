import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { getScopedModules, setScopedModule } from "@/services/org/modules";

/**
 * Narrowing a module for a designation, or for one person.
 *
 * Separate from the organisation-wide route because the two answer different
 * questions and carry different risk: that one decides what the company has,
 * this one only ever takes something away from somebody inside it.
 */
export const GET = route(async () => {
  const ctx = await requireContext();
  return json(await getScopedModules(ctx));
});

const patchSchema = z.object({
  scope: z.enum(["designation", "user"]),
  targetId: z.string().min(1),
  moduleKey: z.string().min(1),
  // Null is "remove the override and follow the layer above" — which is a real
  // choice and not the same as switching it off.
  enabled: z.boolean().nullable(),
});

export const PATCH = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, patchSchema);
  return json(await setScopedModule(ctx, body));
});
