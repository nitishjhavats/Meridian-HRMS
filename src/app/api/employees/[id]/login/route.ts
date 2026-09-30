import { z } from "zod";
import { EMPLOYEE_LOGIN_ROLES } from "@/domain/employees/loginRoles";
import { json, parseBody, route } from "@/lib/http/handler";
import { createLoginForEmployee } from "@/services/employees/credentials";

const bodySchema = z.object({
  role: z.enum(EMPLOYEE_LOGIN_ROLES).optional(),
});

/**
 * A login for somebody who is already in the directory.
 *
 * Everyone imported before logins existed is in exactly this position, so this
 * is not a rare path — it is how an organisation catches up.
 */
export const POST = route<{ id: string }>(async (request, { ctx, params }) => {
  const { role } = await parseBody(request, bodySchema);
  return json({ credential: await createLoginForEmployee(ctx, params.id, role) });
});
