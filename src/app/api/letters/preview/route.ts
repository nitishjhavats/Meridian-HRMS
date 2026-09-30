import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { previewLetter } from "@/services/letters";

/** Fills placeholders so the author sees the real letter before issuing it. */
const schema = z.object({
  employeeId: z.string().min(1),
  category: z.string().min(1),
  body: z.string().max(50_000),
  filled: z.record(z.string(), z.string()).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  return json({ preview: await previewLetter(ctx, body) });
});
