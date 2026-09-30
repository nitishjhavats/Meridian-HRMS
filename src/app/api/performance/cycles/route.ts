import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { closeCycle, createCycle, listCycles, openCycle } from "@/services/performance";

export const GET = route(async (_request, { ctx }) => {
  return json({ cycles: await listCycles(ctx) });
});

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().trim().min(2).max(120),
    startDate: DATE,
    endDate: DATE,
    competencies: z
      .array(z.object({ code: z.string().min(1), label: z.string().min(1), weight: z.number() }))
      .optional(),
  }),
  z.object({ action: z.literal("open"), cycleId: z.string().min(1) }),
  z.object({ action: z.literal("close"), cycleId: z.string().min(1) }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "create":
      return json(await createCycle(ctx, body), { status: 201 });
    case "open":
      return json(await openCycle(ctx, body.cycleId));
    case "close":
      return json(await closeCycle(ctx, body.cycleId));
  }
});
