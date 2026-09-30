import { json, route } from "@/lib/http/handler";
import { listExports, requestExport } from "@/services/export";

export const GET = route(async (_request, { ctx }) => {
  return json({ jobs: await listExports(ctx) });
});

/**
 * Builds an export.
 *
 * The password comes back in this one response and is never in a list, so the
 * client has to show it before the page moves on.
 */
export const POST = route(async (_request, { ctx }) => {
  return json(await requestExport(ctx));
});
