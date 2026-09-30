import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { getFramework, restoreFramework, saveFramework } from "@/services/letters/templates";

const saveSchema = z.object({
  subject: z.string().trim().min(3).max(160),
  header: z.string().max(600).default(""),
  body: z.string().min(40).max(20_000),
  footer: z.string().max(300).default(""),
  signatoryName: z.string().trim().max(120).optional().nullable(),
  signatoryTitle: z.string().trim().max(120).optional().nullable(),
  showLogo: z.boolean().optional(),
  showSignature: z.boolean().optional(),
  showStamp: z.boolean().optional(),
});

export const GET = route<{ category: string }>(async (_request, { ctx, params }) => {
  return json(await getFramework(ctx, params.category));
});

/** The whole framework, not a patch: the four parts are read and edited together. */
export const PUT = route<{ category: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, saveSchema);
  return json({ framework: await saveFramework(ctx, params.category, body) });
});

/** Restore the built-in. Deletes the override rather than copying the default over it. */
export const DELETE = route<{ category: string }>(async (_request, { ctx, params }) => {
  return json({ framework: await restoreFramework(ctx, params.category) });
});
