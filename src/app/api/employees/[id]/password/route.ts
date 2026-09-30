import { json, route } from "@/lib/http/handler";
import { resetEmployeePassword } from "@/services/employees/credentials";

/**
 * A new one-time password for one employee, issued by their own administrator.
 *
 * `POST` rather than `PATCH` because it does not update a field you supplied —
 * it mints something and returns it once. The response is the only place that
 * password will ever exist.
 */
export const POST = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ credential: await resetEmployeePassword(ctx, params.id) });
});
