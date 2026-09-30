import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import { getAiConfig, testAiConnection, updateAiConfig } from "@/services/ai/config";

export const GET = route(async () => {
  const ctx = await requireContext();
  return json({ config: await getAiConfig(ctx) });
});

/**
 * `apiKey` is deliberately nullable-and-optional:
 *   absent → keep the stored key
 *   null   → delete it and fall back to the platform key
 *   string → replace it
 * There is no shape that returns a key, only ones that set it.
 */
const patchSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().trim().max(120).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(256).max(32_000).optional(),
  monthlyTokenCap: z.number().int().min(1_000).max(100_000_000).nullable().optional(),
  apiKey: z.string().max(300).nullable().optional(),
  letterSystemPrompt: z.string().max(4000).nullable().optional(),
  payrollSystemPrompt: z.string().max(4000).nullable().optional(),
});

export const PATCH = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, patchSchema);
  return json({ config: await updateAiConfig(ctx, body) });
});

/** A live round trip to the provider, so a wrong key fails here and not mid-task. */
export const POST = route(async (request) => {
  const ctx = await requireContext();
  await parseBody(request, z.object({ action: z.literal("test") }));
  return json({ test: await testAiConnection(ctx) });
});
