/**
 * Somebody's name.
 *
 * A person's name is a property of the person, not of whether they can sign in.
 * Twenty-four places read it as `employee.user?.name ?? "—"`, so every employee
 * without a login — which is most of them, because the bulk importer creates
 * them that way and a login is opt-in — appeared as an em dash. On their own
 * payslip, in the leave queue, on the exit checklist, in reports.
 *
 * The login's name is kept as a fallback rather than dropped: it is what the
 * organisation's owner has, since that account is created before any employee
 * record exists.
 */

/**
 * `firstName` is **required**, deliberately.
 *
 * Optional fields would let a query that never selected the name satisfy this
 * type structurally, and the helper would fall straight back to the login name
 * — the bug it exists to fix, now silent instead of visible. Required means the
 * compiler names every query that has to widen its `select`.
 */
export interface NameableEmployee {
  firstName: string | null;
  lastName?: string | null;
  user?: { name?: string | null } | null;
}

export function employeeName(employee: NameableEmployee | null | undefined, fallback = "—"): string {
  if (!employee) return fallback;
  const own = [employee.firstName, employee.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return own || employee.user?.name?.trim() || fallback;
}
