import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  addTemplateStep,
  createTemplate,
  deleteTemplate,
  listTemplates,
  moveTemplateStep,
  removeTemplateStep,
  renameTemplate,
} from "@/services/onboarding";

export const GET = route(async (_request, { ctx }) => {
  return json({ templates: await listTemplates(ctx) });
});

const stepTitle = z.string().trim().min(2).max(200);
/** The same window the template step column is written against. */
const offset = z.number().int().min(-90).max(365);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).optional(),
    blank: z.boolean().optional(),
    tasks: z
      .array(
        z.object({
          title: stepTitle,
          dueOffsetDays: offset,
          description: z.string().trim().max(500).optional(),
        }),
      )
      .optional(),
  }),
  z.object({
    action: z.literal("rename"),
    id: z.string().min(1),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("addStep"),
    templateId: z.string().min(1),
    title: stepTitle,
    dueOffsetDays: offset,
    description: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal("removeStep"),
    templateId: z.string().min(1),
    stepId: z.string().min(1),
  }),
  z.object({
    action: z.literal("moveStep"),
    templateId: z.string().min(1),
    stepId: z.string().min(1),
    direction: z.union([z.literal(-1), z.literal(1)]),
  }),
  z.object({ action: z.literal("delete"), id: z.string().min(1) }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  switch (body.action) {
    case "create":
      return json(await createTemplate(ctx, body), { status: 201 });
    case "rename":
      return json(await renameTemplate(ctx, body));
    case "addStep":
      return json(await addTemplateStep(ctx, body), { status: 201 });
    case "removeStep":
      return json(await removeTemplateStep(ctx, body));
    case "moveStep":
      return json(await moveTemplateStep(ctx, body));
    case "delete":
      return json(await deleteTemplate(ctx, body.id));
  }
});
