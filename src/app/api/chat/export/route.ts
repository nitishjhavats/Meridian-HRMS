import { z } from "zod";
import { csvResponse, parseBody, route } from "@/lib/http/handler";
import { exportConversation } from "@/services/chat/export";

/**
 * One conversation, as a CSV, with a written reason.
 *
 * Streamed rather than stored: there is no `DataExportJob` row, no encrypted
 * copy sitting in object storage, and no passphrase. See the service.
 */
const bodySchema = z.object({
  employeeAId: z.string(),
  employeeBId: z.string(),
  reason: z.string().trim().min(20).max(1000),
  /** Default true. Turning it off is recorded on the audit row. */
  notifyParticipants: z.boolean().optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);
  const result = await exportConversation(ctx, body);
  return csvResponse(result.fileName, result.rows);
});
