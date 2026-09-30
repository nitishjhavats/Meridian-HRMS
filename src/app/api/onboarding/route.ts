import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { addTask, applyTemplate, listTasks, setTaskStatus } from "@/services/onboarding";

const querySchema = z.object({
  employeeId: z.string().optional(),
  openOnly: z.coerce.boolean().optional(),
});

export const GET = route(async (request, { ctx }) => {
  return json({ tasks: await listTasks(ctx, parseQuery(request, querySchema)) });
});

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("apply"),
    employeeId: z.string().min(1),
    templateId: z.string().min(1),
    ownerUserId: z.string().optional(),
  }),
  z.object({
    action: z.literal("set"),
    taskId: z.string().min(1),
    status: z.enum(["PENDING", "IN_PROGRESS", "COMPLETED", "SKIPPED"]),
    note: z.string().trim().max(300).optional(),
  }),
  z.object({
    action: z.literal("add"),
    employeeId: z.string().min(1),
    title: z.string().trim().min(2).max(200),
    dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "apply":
      return json(await applyTemplate(ctx, body), { status: 201 });
    case "set":
      return json(await setTaskStatus(ctx, body.taskId, body.status, body.note));
    case "add":
      return json(await addTask(ctx, body), { status: 201 });
  }
});
