/**
 * The permission catalogue and role defaults.
 *
 * Roles are a convenient bucket; authorisation is always by permission string, so
 * an organisation can grant an individual extra rights (an Accountant who may
 * disburse salary, say) without inventing a new role.
 *
 * Scopes let one permission mean different things by role:
 *   `.all`  — every employee in the organisation
 *   `.team` — people who report to me, transitively
 *   `.self` — only my own records
 */

export type SystemRole =
  | "SUPERADMIN"
  | "ORG_OWNER"
  | "ADMIN"
  | "HR_MANAGER"
  | "MANAGER"
  | "TEAM_LEAD"
  /**
   * Authorises an override at an office device, and nothing else.
   *
   * Not a seniority tier. A supervisor is a team member who may stand at the
   * kiosk and vouch for somebody whose face will not scan -- the receptionist,
   * the shift in-charge, whoever is actually there at seven in the morning.
   *
   * It exists because the only ways to do that job were MANAGER, which also
   * confirms people off probation and corrects a whole team's attendance, or a
   * hand-granted `attendance.override` that an administrator had to know to
   * look for. Both hand out far more than the job needs.
   */
  | "SUPERVISOR"
  | "TEAM_MEMBER"
  /**
   * A shared screen, not a person.
   *
   * It exists as its own role rather than as a flag on a Team Member because
   * every `Record<SystemRole, …>` in this file then refuses to compile until it
   * is handled — which is how a device account standing unattended in a
   * reception avoids quietly inheriting `payroll.read.self` and
   * `document.read.self` along with the ability to mark attendance.
   */
  | "KIOSK";

export type Scope = "all" | "team" | "self";

export const ROLE_LABELS: Record<SystemRole, string> = {
  SUPERADMIN: "Superadmin",
  ORG_OWNER: "Organisation Owner",
  ADMIN: "Admin",
  HR_MANAGER: "HR Manager",
  MANAGER: "Manager",
  TEAM_LEAD: "Team Lead",
  SUPERVISOR: "Supervisor",
  TEAM_MEMBER: "Team Member",
  KIOSK: "Office device",
};

/** Seniority, used for "can this user manage that user" checks. Lower is more senior. */
export const ROLE_RANK: Record<SystemRole, number> = {
  SUPERADMIN: 0,
  ORG_OWNER: 1,
  ADMIN: 2,
  HR_MANAGER: 3,
  MANAGER: 4,
  TEAM_LEAD: 5,
  // Below a team lead deliberately: a supervisor authorises one thing at a
  // device, and must not outrank somebody who approves leave for a team.
  SUPERVISOR: 6,
  TEAM_MEMBER: 7,
  // Below everybody. Nothing may be managed *by* a kiosk, and any rank
  // comparison should place it at the bottom rather than beside a person.
  KIOSK: 99,
};

export const PERMISSIONS = [
  // ---- platform (superadmin only)
  "platform.org.read",
  "platform.org.create",
  "platform.org.update",
  "platform.org.suspend",
  "platform.org.readonly_view",
  "platform.payment.read",
  "platform.payment.approve",
  "platform.coupon.manage",
  "platform.passwordreset.read",
  "platform.passwordreset.release",
  "platform.analytics.read",
  "platform.settings.manage",
  "platform.feature.grant",
  // `platform.export.manage` used to sit here. It was declared, granted to the
  // Superadmin, and gated nothing — and the thing it would have gated is a
  // cross-tenant export: one file containing every customer's payroll and every
  // employee's Aadhaar. That is not a capability worth building; deleting the
  // permission is the decision, not an omission. An organisation exports its own
  // data through `org.data.export`, and a superadmin who needs to see inside one
  // does it through an audited, time-limited impersonation session.

  // ---- organisation
  "org.settings.read",
  "org.settings.write",
  "org.modules.manage",
  "org.billing.manage",
  "org.structure.manage",
  "org.data.export",

  // ---- employees
  "employee.read.all",
  "employee.read.team",
  "employee.read.self",
  "employee.create",
  "employee.update",
  "employee.state.change",
  "employee.terminate",
  "employee.salary.read",
  "employee.salary.manage",

  // ---- attendance
  "attendance.mark.self",
  "attendance.read.all",
  "attendance.read.team",
  "attendance.read.self",
  "attendance.override",
  "attendance.regularise.request",
  "attendance.regularise.approve",
  "attendance.settings.manage",
  /**
   * Hand out a one-time PIN that marks attendance with no face check.
   *
   * Its own key, so a screen can be gated on it. Before this the answer to
   * "who may issue one" was `attendance.override` or a reporting line, both in
   * code, and the only place to do it was a widget on the employee profile --
   * which somebody named on the PIN authority screen could not open. Owner and
   * Admin hold it from the bundle; everybody else gets it from a row on that
   * screen (by role, designation or person), folded into the context on load.
   */
  "attendance.pin.issue",
  // Held only by the KIOSK role. Separated so the roster a device may read and
  // the act of marking for somebody are distinct grants.
  "attendance.kiosk.operate",
  "attendance.mark.kiosk",

  // ---- leave
  "leave.request",
  "leave.read.all",
  "leave.read.team",
  "leave.read.self",
  "leave.approve.all",
  "leave.approve.team",
  "leave.type.manage",
  "leave.balance.manage",

  // ---- payroll
  "payroll.run",
  "payroll.read.all",
  "payroll.read.team",
  "payroll.read.self",
  "payroll.approve",
  "payroll.finalize",
  "payroll.unlock",
  "payroll.rules.manage",
  "payroll.adjust",
  "payroll.disburse",
  "advance.manage",
  "salary.structure.manage",

  // ---- documents
  "document.upload.self",
  "document.upload.any",
  "document.read.all",
  "document.read.team",
  "document.read.self",
  "document.verify",
  "document.delete.request",
  "document.delete.approve",

  // ---- letters
  "letter.template.manage",
  "letter.issue",
  "letter.read.all",
  "letter.read.self",

  // ---- announcements
  "announcement.read",
  "announcement.create",
  "announcement.create.team",
  "announcement.moderate",

  // ---- added modules
  "exit.manage",
  "exit.settle",
  "reimbursement.claim",
  "reimbursement.approve",
  "onboarding.manage",
  "asset.manage",
  "performance.manage",
  "performance.review",
  "performance.read.self",

  // ---- cross-cutting
  "recognition.manage",
  "ai.config.manage",
  "ai.use",
  "audit.read",
  "report.export",
  "notification.read",
  "chat.use",
  "chat.export",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const TEAM_MEMBER_PERMISSIONS: Permission[] = [
  "employee.read.self",
  "attendance.mark.self",
  "attendance.read.self",
  "attendance.regularise.request",
  "leave.request",
  "leave.read.self",
  "payroll.read.self",
  "document.upload.self",
  "document.read.self",
  "document.delete.request",
  "letter.read.self",
  "announcement.read",
  "reimbursement.claim",
  "performance.read.self",
  "notification.read",
  // A permission rather than "module on means everybody chats": it is the only
  // lever an organisation has for taking chat away from one person without
  // switching it off for the whole company.
  "chat.use",
];

const TEAM_LEAD_PERMISSIONS: Permission[] = [
  ...TEAM_MEMBER_PERMISSIONS,
  "employee.read.team",
  "attendance.read.team",
  "attendance.regularise.approve",
  "leave.read.team",
  "leave.approve.team",
  "payroll.read.team",
  "document.read.team",
  "announcement.create.team",
  "reimbursement.approve",
  "performance.review",
  "report.export",
];

/**
 * A manager: a team lead, plus the two things that otherwise force an
 * escalation to HR for something about their own people.
 *
 * The load-bearing rule for this tier is that **every permission it adds must
 * already be in `HR_MANAGER_PERMISSIONS`**. The sets are cumulative, so adding
 * anything new here would silently widen HR Manager, Admin and Owner as well.
 * There is a test for exactly that.
 *
 * `attendance.override` is only safe because `overrideDay` is scoped through
 * `visibleEmployeeIds` -- attendance decides payable days, which is pay, and
 * before that check landed this would have handed one person every employee's
 * attendance.
 *
 * Deliberately absent: `employee.update`, `employee.create`, `onboarding.manage`
 * and `document.verify`. None of them has a `.team` suffix and none of their
 * services scope-check, so granting one is organisation-wide edit rights
 * wearing a team permission's clothes. `employee.salary.read` stays Admin-only,
 * and `leave.balance.manage` stays with HR because paid leave is money.
 */
const MANAGER_PERMISSIONS: Permission[] = [
  ...TEAM_LEAD_PERMISSIONS,
  "employee.state.change",
  "attendance.override",
];

const HR_MANAGER_PERMISSIONS: Permission[] = [
  ...MANAGER_PERMISSIONS,
  "org.settings.read",
  "employee.read.all",
  "employee.create",
  "employee.update",
  "employee.state.change",
  "attendance.read.all",
  "attendance.override",
  "leave.read.all",
  "leave.approve.all",
  "leave.type.manage",
  "leave.balance.manage",
  "payroll.read.all",
  "document.upload.any",
  "document.read.all",
  "document.verify",
  "document.delete.approve",
  "letter.template.manage",
  "letter.issue",
  "letter.read.all",
  "announcement.create",
  "announcement.moderate",
  "onboarding.manage",
  "asset.manage",
  "exit.manage",
  "ai.use",
];

const ADMIN_PERMISSIONS: Permission[] = [
  ...HR_MANAGER_PERMISSIONS,
  "org.settings.write",
  "org.modules.manage",
  "org.billing.manage",
  "org.structure.manage",
  "employee.terminate",
  "employee.salary.read",
  "employee.salary.manage",
  "attendance.settings.manage",
  "attendance.pin.issue",
  "payroll.run",
  "payroll.approve",
  "payroll.finalize",
  "payroll.rules.manage",
  "payroll.adjust",
  "payroll.disburse",
  "advance.manage",
  "salary.structure.manage",
  "exit.settle",
  "performance.manage",
  "recognition.manage",
  "ai.config.manage",
  "audit.read",
  // Reading two people's private messages, with a written reason on the
  // organisation's own audit log. Deliberately not HR's.
  "chat.export",
];

// An export is every salary and every record in one file. It stays with the
// one person who owns the organisation, not with everybody who can administer it.
const ORG_OWNER_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  "payroll.unlock",
  "org.data.export",
];

const SUPERADMIN_PERMISSIONS: Permission[] = [
  "platform.org.read",
  "platform.org.create",
  "platform.org.update",
  "platform.org.suspend",
  "platform.org.readonly_view",
  "platform.payment.read",
  "platform.payment.approve",
  "platform.coupon.manage",
  "platform.passwordreset.read",
  "platform.passwordreset.release",
  "platform.analytics.read",
  "platform.settings.manage",
  "platform.feature.grant",
  "audit.read",
  "report.export",
  "notification.read",
];

/**
 * Two permissions and nothing else.
 *
 * Not built on TEAM_MEMBER: the whole point is that this account cannot read a
 * payslip, open a document or see a notification. If a kiosk ever needs
 * something more, it should be added here deliberately and one line at a time.
 */
/**
 * A team member, plus the one thing a supervisor is for.
 *
 * `attendance.override` is the permission `supervisorOverride` checks when
 * somebody types their credentials into the kiosk's bypass panel. It is safe
 * here for the same reason it is safe on MANAGER: `overrideDay` scopes every
 * write through `visibleEmployeeIds`, so holding it does not hand somebody the
 * whole organisation's attendance -- and the kiosk path records what it did as
 * unverified with the authoriser named.
 *
 * `attendance.read.team` comes with it so a supervisor can see the day they
 * just vouched for. Nothing else: no leave approval, no probation, no reports.
 * The whole point of this role is that it is *narrower* than the alternatives.
 */
const SUPERVISOR_PERMISSIONS: Permission[] = [
  ...TEAM_MEMBER_PERMISSIONS,
  "attendance.read.team",
  "attendance.override",
];

const KIOSK_PERMISSIONS: Permission[] = ["attendance.kiosk.operate", "attendance.mark.kiosk"];

export const ROLE_PERMISSIONS: Record<SystemRole, readonly Permission[]> = {
  SUPERADMIN: dedupe(SUPERADMIN_PERMISSIONS),
  ORG_OWNER: dedupe(ORG_OWNER_PERMISSIONS),
  ADMIN: dedupe(ADMIN_PERMISSIONS),
  HR_MANAGER: dedupe(HR_MANAGER_PERMISSIONS),
  MANAGER: dedupe(MANAGER_PERMISSIONS),
  TEAM_LEAD: dedupe(TEAM_LEAD_PERMISSIONS),
  SUPERVISOR: dedupe(SUPERVISOR_PERMISSIONS),
  KIOSK: dedupe(KIOSK_PERMISSIONS),
  TEAM_MEMBER: dedupe(TEAM_MEMBER_PERMISSIONS),
};

function dedupe(list: Permission[]): Permission[] {
  return [...new Set(list)];
}

/**
 * Effective permissions = role defaults, plus per-user grants, minus per-user
 * revocations. Superadmin permissions are never granted to an org user and vice
 * versa; the grant table cannot be used to cross that line.
 */
export function effectivePermissions(
  role: SystemRole,
  grants: readonly { permission: string; granted: boolean }[] = [],
): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);

  // A kiosk takes no grants at all. Its whole safety argument is that the set
  // above is exhaustive, and a per-user grant is exactly the mechanism that
  // would quietly widen it on a device nobody is watching.
  if (role === "KIOSK") return set;

  const platformOnly = role !== "SUPERADMIN";

  for (const grant of grants) {
    const permission = grant.permission as Permission;
    if (!PERMISSIONS.includes(permission)) continue;
    if (platformOnly && permission.startsWith("platform.")) continue;
    if (role === "SUPERADMIN" && !permission.startsWith("platform.") && !SUPERADMIN_PERMISSIONS.includes(permission)) {
      continue;
    }
    if (grant.granted) set.add(permission);
    else set.delete(permission);
  }
  return set;
}

/**
 * The widest scope a permission family allows this holder. The client never sends
 * a scope — the server derives it and builds the query filter from it.
 */
export function resolveScope(
  permissions: ReadonlySet<Permission>,
  family: string,
): Scope | null {
  if (permissions.has(`${family}.all` as Permission)) return "all";
  if (permissions.has(`${family}.team` as Permission)) return "team";
  if (permissions.has(`${family}.self` as Permission)) return "self";
  return null;
}

export function canManageRole(actor: SystemRole, target: SystemRole): boolean {
  // Nobody may create or edit a peer or a senior, and only the platform may mint
  // another Superadmin.
  if (target === "SUPERADMIN") return actor === "SUPERADMIN";
  return ROLE_RANK[actor] < ROLE_RANK[target];
}

/** Roles an actor is allowed to assign when creating a user. */
export function assignableRoles(actor: SystemRole): SystemRole[] {
  return (Object.keys(ROLE_RANK) as SystemRole[]).filter((r) => canManageRole(actor, r));
}
