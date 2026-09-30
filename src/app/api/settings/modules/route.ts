import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { listModules, setModules } from "@/services/org/modules";

export const GET = route(async () => {
  const ctx = await requireContext();
  return json({ modules: await listModules(ctx) });
});

/**
 * A partial map, not the whole board: sending only what changed means a stale
 * tab cannot undo somebody else's toggle by echoing back what it loaded.
 */
const patchSchema = z.object({
  modules: z.record(z.string(), z.boolean()),
});

export const PATCH = route(async (request) => {
  const ctx = await requireContext();
  const { modules } = await parseBody(request, patchSchema);
  return json({ modules: await setModules(ctx, modules) });
});
