import { json, route } from "@/lib/http/handler";
import { deleteHoliday, getCalendar } from "@/services/org/calendar";

/**
 * The only delete on this screen. A shift or a pattern is switched off instead,
 * because rows that outlive them point at them; a holiday is referenced by
 * nothing and the calendar is rebuilt from the table each time it is asked for.
 */
export const DELETE = route<{ id: string }>(async (_request, { ctx, params }) => {
  await deleteHoliday(ctx, params.id);
  return json(await getCalendar(ctx));
});
