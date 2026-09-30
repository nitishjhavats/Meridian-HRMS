import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { createLetter, listLetters } from "@/services/letters";

const querySchema = z.object({
  employeeId: z.string().optional(),
  status: z.enum(["DRAFT", "ISSUED", "REVOKED"]).optional(),
});

export const GET = route(async (request, { ctx }) => {
  const filters = parseQuery(request, querySchema);
  return json({ letters: await listLetters(ctx, filters) });
});

const createSchema = z.object({
  employeeId: z.string().min(1),
  category: z.string().min(1),
  subject: z.string().trim().min(2).max(200),
  body: z.string().min(10).max(50_000),
  templateId: z.string().optional(),
  aiPrompt: z.string().max(4000).optional(),
  aiModel: z.string().max(120).optional(),
  /** Placeholder values typed into the fill-in form beside the editor. */
  filled: z.record(z.string(), z.string()).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, createSchema);
  return json(await createLetter(ctx, body), { status: 201 });
});
