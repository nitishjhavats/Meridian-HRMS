import { created, json, parseBody, route } from "@/lib/http/handler";
import { listEmployees } from "@/services/employees";
import { createEmployee } from "@/services/employees/write";
import { createEmployeeSchema } from "@/services/employees/schema";
import { saveSalaryProfile } from "@/services/payroll/salaryStructure";

/**
 * The employee directory.
 *
 * `GET` mirrors what the page already renders, for anything that needs the list
 * without a page around it. `POST` is the path that did not exist: until now an
 * organisation could only contain the people a seed script had put there.
 *
 * `POST` may also mint that person's login, in which case the response carries a
 * one-time password. It is returned exactly once — nothing stores the plaintext,
 * so whoever called this either hands it over or issues a new one.
 */

export const GET = route(async (_request, { ctx }) => {
  return json({ employees: await listEmployees(ctx, {}) });
});

export const POST = route(async (request, { ctx }) => {
  const { login, annualCtcPaise, ...body } = await parseBody(request, createEmployeeSchema);
  const result = await createEmployee(ctx, body, login ?? { create: false });

  // Pay is a separate, deliberately narrower permission: `employee.create` is
  // held by HR, `employee.salary.manage` by Admins. The form only offers the
  // field to somebody who holds it, and this is the server saying the same.
  if (annualCtcPaise && ctx.permissions.has("employee.salary.manage")) {
    await saveSalaryProfile(ctx, result.employee.id, {
      ctcMonthlyPaise: Math.round(annualCtcPaise / 12),
      effectiveFrom: body.joiningDate,
      note: "Set when they were added",
    });
  }

  return created({ employee: result.employee, credential: result.credential });
});
