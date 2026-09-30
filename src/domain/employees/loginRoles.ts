/**
 * The roles an employee's login may be given.
 *
 * One list. There were six byte-identical copies of it — `credentials.ts`,
 * `employees/schema.ts`, two API routes, the employee form and the login
 * controls on the profile — and only one of them was reachable from the
 * compiler, so adding a role meant finding the other five by hand or shipping a
 * picker that offered something the server refuses.
 *
 * Never `ORG_OWNER`, `SUPERADMIN` or `KIOSK`: the first is the billing
 * relationship, the second is Broadmate, and the third is a screen bolted to a
 * wall rather than a person.
 */

export const EMPLOYEE_LOGIN_ROLES = [
  "TEAM_MEMBER",
  "SUPERVISOR",
  "TEAM_LEAD",
  "MANAGER",
  "HR_MANAGER",
  "ADMIN",
] as const;

export type EmployeeLoginRole = (typeof EMPLOYEE_LOGIN_ROLES)[number];

/**
 * What each one means, in the words of somebody choosing it.
 *
 * `TEAM_LEAD` used to be labelled "Manager", which was fine until there was an
 * actual Manager role — at which point the picker offered two options with the
 * same name and no way to tell them apart.
 */
export const EMPLOYEE_LOGIN_ROLE_LABELS: { value: EmployeeLoginRole; label: string }[] = [
  { value: "TEAM_MEMBER", label: "Employee — their own attendance, leave and payslips" },
  {
    value: "SUPERVISOR",
    label: "Supervisor — an employee who can also authorise an override at the office device",
  },
  { value: "TEAM_LEAD", label: "Team lead — the above, plus approving for their direct reports" },
  {
    value: "MANAGER",
    label: "Manager — a team lead's powers, plus confirming and correcting their own team",
  },
  { value: "HR_MANAGER", label: "HR — people, attendance and leave across the organisation" },
  { value: "ADMIN", label: "Administrator — everything except billing ownership" },
];

export function isEmployeeLoginRole(value: unknown): value is EmployeeLoginRole {
  return EMPLOYEE_LOGIN_ROLES.includes(value as EmployeeLoginRole);
}
