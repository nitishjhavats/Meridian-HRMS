import { noContent, route } from "@/lib/http/handler";
import { removeAdjustment } from "@/services/payroll/adjustments";

export const DELETE = route<{ id: string }>(async (_request, { ctx, params }) => {
  await removeAdjustment(ctx, params.id);
  return noContent();
});
