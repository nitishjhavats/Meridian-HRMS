import { json, parseBody, route } from "@/lib/http/handler";
import { getEmployee } from "@/services/employees";
import { updateEmployee } from "@/services/employees/write";
import { employeeSchema } from "@/services/employees/schema";

export const GET = route<{ id: string }>(async (_request, { ctx, params }) => {
  return json({ employee: await getEmployee(ctx, params.id) });
});

/** Everything is optional on a patch — a form may send only what it changed. */
export const PATCH = route<{ id: string }>(async (request, { ctx, params }) => {
  const body = await parseBody(request, employeeSchema.partial());
  return json({ employee: await updateEmployee(ctx, params.id, body) });
});
