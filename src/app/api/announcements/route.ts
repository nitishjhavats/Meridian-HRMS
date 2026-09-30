import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { createAnnouncement, listAnnouncements } from "@/services/announcements";

const audienceSchema = z.object({
  scope: z.enum(["ALL", "DEPARTMENT", "ROLE", "LOCATION", "EMPLOYEES"]),
  departmentIds: z.array(z.string()).optional(),
  roles: z.array(z.string()).optional(),
  workLocationIds: z.array(z.string()).optional(),
  employeeIds: z.array(z.string()).optional(),
});

export const GET = route(async (_request, { ctx }) => {
  return json({ announcements: await listAnnouncements(ctx) });
});

const createSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(20_000),
  audience: audienceSchema.optional(),
  pinned: z.boolean().optional(),
  publishAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  commentsEnabled: z.boolean().optional(),
  published: z.boolean().optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, createSchema);
  return json(await createAnnouncement(ctx, body), { status: 201 });
});
