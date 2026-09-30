import { z } from "zod";
import { json, parseBody, route } from "@/lib/http/handler";
import { listReports, markReportReviewed } from "@/services/chat";

export const GET = route(async (_request, { ctx }) => {
  return json({ reports: await listReports(ctx) });
});

export const POST = route(async (request, { ctx }) => {
  const { reportId } = await parseBody(request, z.object({ reportId: z.string() }));
  return json(await markReportReviewed(ctx, reportId));
});
