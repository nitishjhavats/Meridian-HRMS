import { z } from "zod";
import { csvResponse, json, parseQuery, route } from "@/lib/http/handler";
import { runReport, type ReportKind } from "@/services/reports";

/**
 * One route for every report.
 *
 * `?format=json` returns the same rows the CSV contains, so the screen's
 * preview is provably the file rather than a separate rendering of it.
 */
const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  format: z.enum(["csv", "json"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const GET = route<{ kind: string }>(async (request, { ctx, params }) => {
  const options = parseQuery(request, querySchema);
  const result = await runReport(ctx, params.kind as ReportKind, options);

  if (options.format === "json") {
    const limit = options.limit ?? 50;
    return json({
      name: result.name,
      filename: result.filename,
      // Header plus a page of rows; the count is of data rows, not including it.
      header: result.rows[0] ?? [],
      rows: result.rows.slice(1, limit + 1),
      total: Math.max(0, result.rows.length - 1),
    });
  }

  return csvResponse(result.filename, result.rows);
});
