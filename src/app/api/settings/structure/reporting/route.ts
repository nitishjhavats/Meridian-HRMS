import { z } from "zod";
import { created, json, parseBody, route } from "@/lib/http/handler";
import { endReportingLine, listReportingLines, setReportingLine } from "@/services/org/structure";

export const GET = route(async (_request, { ctx }) => {
  return json({ lines: await listReportingLines(ctx) });
});

const createSchema = z.object({
  employeeId: z.string().min(1),
  managerId: z.string().min(1),
  type: z.enum(["PRIMARY", "SECONDARY"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, createSchema);
  return created({ line: await setReportingLine(ctx, body) });
});

/**
 * Ending a line, never deleting one.
 *
 * `endDate` is what `teamEmployeeIds` reads to decide who reports to whom today,
 * and last March's approvals have to keep the manager who gave them.
 */
const endSchema = z.object({
  id: z.string().min(1),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const PATCH = route(async (request, { ctx }) => {
  const body = await parseBody(request, endSchema);
  return json({ line: await endReportingLine(ctx, body.id, body.endDate) });
});
