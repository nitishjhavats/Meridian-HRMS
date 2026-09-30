import { json, route } from "@/lib/http/handler";
import { getEmployeeFormOptions } from "@/services/employees/write";

/** Departments, designations, locations, shifts and the next free code. */
export const GET = route(async (_request, { ctx }) => {
  return json(await getEmployeeFormOptions(ctx));
});
