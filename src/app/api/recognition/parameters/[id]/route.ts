import { json, route } from "@/lib/http/handler";
import { deleteParameter } from "@/services/recognition";

/**
 * Removes a parameter no month has ever scored; deactivates one that has.
 *
 * The response says which happened, because "it is still listed, greyed out" is
 * a surprise unless the screen can explain it.
 */
export const DELETE = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json(await deleteParameter(ctx, params.id));
});
