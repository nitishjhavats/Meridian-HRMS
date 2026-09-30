import { json, route } from "@/lib/http/handler";
import { listFlaggedEvents } from "@/services/attendance/review";

/** Attendance that was marked but could not be verified, waiting to be looked at. */
export const GET = route(async (_request, { ctx }) => {
  return json({ events: await listFlaggedEvents(ctx) });
});
