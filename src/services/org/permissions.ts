import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { assertSameTenant, requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import {
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  type Permission,
  type SystemRole,
  canManageRole,
  effectivePermissions,
} from "@/lib/auth/permissions";

/**
 * Per-person permission grants.
 *
 * `UserPermissionGrant` has been read by `effectivePermissions` since the
 * permission model was written and written by nothing at all, so a role could
 * never be adjusted for one person: the Accountant who may disburse salary —
 * the example in the permission catalogue's own opening comment — was not
 * actually expressible. This service is the missing half.
 *
 * Three things make it different from the other settings screens.
 *
 * First, the answer it shows is not computed here. `effective` comes from
 * `effectivePermissions`, the same call `loadContext` makes to build the set the
 * guards test, so what this screen says somebody can do and what the server will
 * let them do cannot drift apart. `outcomes` is that same function asked three
 * more times, once per option, rather than a client-side guess at what a grant
 * would mean.
 *
 * Second, the three-way view is the point. A flat checklist tells you somebody
 * has `payroll.disburse` and hides the far more useful fact that their role does
 * not include it and a named person added it. Every row therefore carries the
 * role default, the override, and the result.
 *
 * Third, and most important: **nobody can give away what they do not hold.**
 * Without that rule this screen is a privilege-escalation ladder with a tidy
 * layout. An HR Manager holding `org.settings.write` cannot pick themselves, so
 * they would instead grant a Team Lead `payroll.finalize` and have manufactured
 * authority that no role in the organisation gives out. The check is on the
 * *outcome* of the change rather than on the word "grant", because clearing an
 * override restores a permission just as effectively as adding one.
 */

/* -------------------------------------------------------------------------- */
/*  The catalogue                                                              */
/* -------------------------------------------------------------------------- */

type GroupKey =
  | "organisation"
  | "people"
  | "attendance"
  | "leave"
  | "payroll"
  | "documents"
  | "letters"
  | "announcements"
  | "workflows"
  | "assistance"
  /** Superadmin-only, and never offered here — see `ORG_PERMISSIONS` below. */
  | "platform";

interface PermissionMeta {
  group: GroupKey;
  label: string;
  /** What it lets somebody actually do, in a sentence worth reading. */
  description: string;
  /**
   * Moves money, exposes everybody's pay or identity documents, or hands out
   * authority. The screen asks twice before adding one of these.
   */
  sensitive?: true;
}

/**
 * A full `Record`, deliberately.
 *
 * A permission added to `PERMISSIONS` without a description here fails to
 * compile, which is the only reliable way to stop this screen quietly growing a
 * row that explains nothing and hands out real authority.
 */
const PERMISSION_META: Record<Permission, PermissionMeta> = {
  // ---- platform: filtered out below. `effectivePermissions` discards a
  // `platform.*` grant on every non-Superadmin, so offering one here would be a
  // control that appears to work, saves happily, and changes nothing.
  "platform.org.read": { group: "platform", label: "Read organisations", description: "Platform owner only." },
  "platform.org.create": { group: "platform", label: "Create organisations", description: "Platform owner only." },
  "platform.org.update": { group: "platform", label: "Update organisations", description: "Platform owner only." },
  "platform.org.suspend": { group: "platform", label: "Suspend organisations", description: "Platform owner only." },
  "platform.org.readonly_view": { group: "platform", label: "Read-only support view", description: "Platform owner only." },
  "platform.payment.read": { group: "platform", label: "Read payments", description: "Platform owner only." },
  "platform.payment.approve": { group: "platform", label: "Approve payments", description: "Platform owner only." },
  "platform.coupon.manage": { group: "platform", label: "Manage coupons", description: "Platform owner only." },
  "platform.passwordreset.read": { group: "platform", label: "Read reset requests", description: "Platform owner only." },
  "platform.passwordreset.release": { group: "platform", label: "Release reset codes", description: "Platform owner only." },
  "platform.analytics.read": { group: "platform", label: "Platform analytics", description: "Platform owner only." },
  "platform.settings.manage": { group: "platform", label: "Platform settings", description: "Platform owner only." },
  "platform.feature.grant": { group: "platform", label: "Grant features", description: "Platform owner only." },

  // ---- organisation
  "org.settings.read": {
    group: "organisation",
    label: "See the organisation's settings",
    description:
      "Open the settings screens and read them — the working calendar, the attendance rules, which modules are on — without being able to change any of it.",
  },
  "org.settings.write": {
    group: "organisation",
    label: "Change the organisation's settings",
    description:
      "Edit the calendar, the attendance rules and everything else under Settings, including this screen. Anybody with this can hand out every permission they themselves hold.",
    sensitive: true,
  },
  "org.modules.manage": {
    group: "organisation",
    label: "Switch modules on and off",
    description:
      "Turn a whole area of the product — payroll, leave, documents — on or off for everybody at once.",
    sensitive: true,
  },
  "org.billing.manage": {
    group: "organisation",
    label: "Manage the subscription",
    description: "See invoices, buy seats and complete payments on the organisation's behalf.",
    sensitive: true,
  },
  "org.structure.manage": {
    group: "organisation",
    label: "Departments, job titles and offices",
    description:
      "Add or retire departments and designations, and set the office locations attendance is measured against.",
  },
  "org.data.export": {
    group: "organisation",
    label: "Export the whole organisation",
    description:
      "Download every employee record, salary and payslip in a single file. The organisation owner alone holds this by default, and for good reason.",
    sensitive: true,
  },

  // ---- people
  "employee.read.all": {
    group: "people",
    label: "See everybody's record",
    description: "Open the record of any employee in the organisation, not only their own team.",
  },
  "employee.read.team": {
    group: "people",
    label: "See their team's records",
    description: "Open the record of anybody who reports to them, however far down the chain.",
  },
  "employee.read.self": {
    group: "people",
    label: "See their own record",
    description: "Read their own profile. Almost everybody should have this.",
  },
  "employee.create": {
    group: "people",
    label: "Add people",
    description: "Create employee records one at a time, or by importing a spreadsheet.",
  },
  "employee.update": {
    group: "people",
    label: "Edit people's details",
    description:
      "Change names, contact details, department, designation, shift and reporting lines for anybody they can see.",
  },
  "employee.state.change": {
    group: "people",
    label: "Move somebody through probation",
    description:
      "Change employment state — training, probation, confirmed, notice period. Payroll and leave rules read this.",
  },
  "employee.terminate": {
    group: "people",
    label: "End somebody's employment",
    description:
      "Mark an employee as exited, which stops their pay, releases their seat and closes their access.",
    sensitive: true,
  },
  "employee.salary.read": {
    group: "people",
    label: "See what people are paid",
    description: "Read the salary structure attached to any employee they can already see.",
    sensitive: true,
  },
  "employee.salary.manage": {
    group: "people",
    label: "Set what people are paid",
    description:
      "Change somebody's salary structure. The new figures are what the next payroll run calculates from.",
    sensitive: true,
  },

  // ---- attendance
  "attendance.mark.self": {
    group: "attendance",
    label: "Check in and out",
    description: "Mark their own attendance from the app, within whatever geofence rules apply to them.",
  },
  "attendance.read.all": {
    group: "attendance",
    label: "See everybody's attendance",
    description: "Read the attendance of any employee, and the organisation-wide daily register.",
  },
  "attendance.read.team": {
    group: "attendance",
    label: "See their team's attendance",
    description: "Read the attendance of anybody reporting to them.",
  },
  "attendance.read.self": {
    group: "attendance",
    label: "See their own attendance",
    description: "Read their own days, hours and monthly summary.",
  },
  "attendance.override": {
    group: "attendance",
    label: "Correct a day after the fact",
    description:
      "Change what a day was marked as — present, absent, half day — once it has passed. That changes payable days, so it changes pay.",
    sensitive: true,
  },
  "attendance.regularise.request": {
    group: "attendance",
    label: "Ask for a correction",
    description: "Raise a regularisation request against one of their own days, with a reason.",
  },
  "attendance.regularise.approve": {
    group: "attendance",
    label: "Approve corrections",
    description:
      "Accept or refuse a regularisation request from their team. An approved one rewrites the day, and the payable days with it.",
  },
  "attendance.settings.manage": {
    group: "attendance",
    label: "Set the attendance rules",
    description:
      "Grace periods, half-day and absence thresholds, geofencing and selfie requirements — for everybody.",
  },
  "attendance.pin.issue": {
    group: "attendance",
    label: "Issue attendance PINs",
    description:
      "Hand out a one-time code that marks attendance without a face check -- a bandage, a new beard, no photo on file yet. The mark it makes is flagged for review, and every PIN names who issued it.",
    sensitive: true,
  },
  "attendance.kiosk.operate": {
    group: "attendance",
    label: "Run a shared office device",
    description:
      "Show the shared check-in screen and the roster on it. Normally held by a device account rather than a person.",
  },
  "attendance.mark.kiosk": {
    group: "attendance",
    label: "Mark attendance for somebody else",
    description:
      "Record a check-in on behalf of whoever is standing at a shared screen. Normally held by a device account rather than a person.",
    sensitive: true,
  },

  // ---- leave
  "leave.request": {
    group: "leave",
    label: "Apply for leave",
    description: "Submit their own leave applications against their balance.",
  },
  "leave.read.all": {
    group: "leave",
    label: "See everybody's leave",
    description: "Read the leave and balances of any employee, and the organisation leave calendar.",
  },
  "leave.read.team": {
    group: "leave",
    label: "See their team's leave",
    description: "Read the leave and balances of anybody reporting to them.",
  },
  "leave.read.self": {
    group: "leave",
    label: "See their own leave",
    description: "Read their own applications and balances.",
  },
  "leave.approve.all": {
    group: "leave",
    label: "Approve anybody's leave",
    description: "Accept or refuse a leave application from any employee, not only their own team.",
  },
  "leave.approve.team": {
    group: "leave",
    label: "Approve their team's leave",
    description: "Accept or refuse a leave application from somebody reporting to them.",
  },
  "leave.type.manage": {
    group: "leave",
    label: "Set up leave types",
    description:
      "Create leave types and set their entitlement, accrual, carry-forward, and whether they are paid.",
  },
  "leave.balance.manage": {
    group: "leave",
    label: "Adjust leave balances",
    description:
      "Add days to or take days from somebody's balance, set opening balances, and run the year-end carry-forward. Paid leave is money.",
    sensitive: true,
  },

  // ---- pay
  "payroll.run": {
    group: "payroll",
    label: "Start a payroll run",
    description: "Create the month's run and calculate it from attendance, leave and salary structures.",
    sensitive: true,
  },
  "payroll.read.all": {
    group: "payroll",
    label: "See everybody's pay",
    description: "Read every payslip and the full payroll register, for every employee.",
    sensitive: true,
  },
  "payroll.read.team": {
    group: "payroll",
    label: "See their team's pay",
    description: "Read the payslips of anybody reporting to them.",
    sensitive: true,
  },
  "payroll.read.self": {
    group: "payroll",
    label: "See their own payslips",
    description: "Read and download their own payslips.",
  },
  "payroll.approve": {
    group: "payroll",
    label: "Approve a payroll run",
    description: "Sign off the calculated figures for a month as correct, ready to be locked and paid.",
    sensitive: true,
  },
  "payroll.finalize": {
    group: "payroll",
    label: "Lock a payroll run",
    description:
      "Close the month. Payslips are issued, and what sits behind them — attendance, leave, the calendar — can no longer be changed.",
    sensitive: true,
  },
  "payroll.unlock": {
    group: "payroll",
    label: "Reopen a locked month",
    description:
      "Unlock a month that was already closed so its figures can be changed again. The organisation owner alone holds this by default.",
    sensitive: true,
  },
  "payroll.rules.manage": {
    group: "payroll",
    label: "Set the payroll rules",
    description:
      "Provident fund, ESI, professional tax and rounding — the rules every payslip in the organisation is calculated with.",
    sensitive: true,
  },
  "payroll.adjust": {
    group: "payroll",
    label: "Add a one-off adjustment",
    description: "Put a bonus, arrear or deduction onto somebody's payslip for a single month.",
    sensitive: true,
  },
  "payroll.disburse": {
    group: "payroll",
    label: "Mark salary as paid",
    description:
      "Record that a locked run has actually been paid out, and from which account. This is the step that says the money moved.",
    sensitive: true,
  },
  "advance.manage": {
    group: "payroll",
    label: "Salary advances",
    description:
      "Issue an advance against future salary, and set how it is recovered from later payslips.",
    sensitive: true,
  },
  "salary.structure.manage": {
    group: "payroll",
    label: "Design the salary components",
    description:
      "Create and change the components pay is built from — basic, HRA, allowances — and the formula behind each one.",
    sensitive: true,
  },

  // ---- documents
  "document.upload.self": {
    group: "documents",
    label: "Upload their own documents",
    description: "Add documents to their own record — identity proofs, certificates and the like.",
  },
  "document.upload.any": {
    group: "documents",
    label: "Upload documents for anybody",
    description: "Add a document to any employee's record.",
  },
  "document.read.all": {
    group: "documents",
    label: "Read everybody's documents",
    description:
      "Open any document in the organisation, identity documents such as PAN and Aadhaar included.",
    sensitive: true,
  },
  "document.read.team": {
    group: "documents",
    label: "Read their team's documents",
    description: "Open the documents of anybody reporting to them.",
  },
  "document.read.self": {
    group: "documents",
    label: "Read their own documents",
    description: "Open and download the documents on their own record.",
  },
  "document.verify": {
    group: "documents",
    label: "Verify a document",
    description: "Mark somebody's document as checked and genuine, which onboarding treats as done.",
  },
  "document.delete.request": {
    group: "documents",
    label: "Ask for a document to be deleted",
    description: "Raise a deletion request. Nothing is removed until somebody else approves it.",
  },
  "document.delete.approve": {
    group: "documents",
    label: "Delete documents",
    description: "Approve a deletion request and remove the file for good. There is no undo.",
    sensitive: true,
  },

  // ---- letters
  "letter.template.manage": {
    group: "letters",
    label: "Edit the letter templates",
    description:
      "Change the wording every offer, confirmation and relieving letter is generated from, for everybody.",
  },
  "letter.issue": {
    group: "letters",
    label: "Issue letters",
    description:
      "Generate a letter for an employee and issue it in the organisation's name. An issued letter is a record.",
  },
  "letter.read.all": {
    group: "letters",
    label: "Read every letter issued",
    description: "See the letters issued to anybody, and their history.",
  },
  "letter.read.self": {
    group: "letters",
    label: "Read their own letters",
    description: "See and download the letters issued to them.",
  },

  // ---- announcements and recognition
  "announcement.read": {
    group: "announcements",
    label: "Read announcements",
    description: "See the noticeboard, and comment on posts.",
  },
  "announcement.create": {
    group: "announcements",
    label: "Post to everybody",
    description: "Publish an announcement the whole organisation sees.",
  },
  "announcement.create.team": {
    group: "announcements",
    label: "Post to their team",
    description: "Publish an announcement limited to the people reporting to them.",
  },
  "announcement.moderate": {
    group: "announcements",
    label: "Moderate the noticeboard",
    description: "Edit, pin or remove anybody's post, and remove comments.",
  },
  "recognition.manage": {
    group: "announcements",
    label: "Run Employee of the Month",
    description:
      "Decide what the award is scored on and how much each thing counts, enter the scores, and publish the winner.",
  },

  // ---- joining, exit, expenses, reviews
  "exit.manage": {
    group: "workflows",
    label: "Run an exit",
    description: "Start and track somebody's exit — notice period, clearance and handover.",
  },
  "exit.settle": {
    group: "workflows",
    label: "Settle an exit",
    description:
      "Calculate and approve the full and final settlement. That is a payment, and it closes the employment.",
    sensitive: true,
  },
  "reimbursement.claim": {
    group: "workflows",
    label: "Claim expenses",
    description: "Submit their own expense claims, with receipts.",
  },
  "reimbursement.approve": {
    group: "workflows",
    label: "Approve expense claims",
    description: "Accept or refuse a claim from their team. An approved claim becomes money paid out.",
    sensitive: true,
  },
  "onboarding.manage": {
    group: "workflows",
    label: "Run onboarding",
    description: "Assign and track the joining checklist for a new starter.",
  },
  "asset.manage": {
    group: "workflows",
    label: "Issue and take back assets",
    description: "Record the laptops, phones and equipment given to employees, and returned by them.",
  },
  "performance.manage": {
    group: "workflows",
    label: "Run performance cycles",
    description: "Open and close review cycles, and set what they measure.",
  },
  "performance.review": {
    group: "workflows",
    label: "Write reviews",
    description: "Complete a performance review for somebody reporting to them.",
  },
  "performance.read.self": {
    group: "workflows",
    label: "Read their own reviews",
    description: "See their own goals and completed reviews.",
  },

  // ---- assistant, audit, reports
  "ai.config.manage": {
    group: "assistance",
    label: "Set up the AI assistant",
    description:
      "Hold the organisation's API key, and decide what the assistant is allowed to be shown.",
    sensitive: true,
  },
  "ai.use": {
    group: "assistance",
    label: "Use the AI assistant",
    description: "Ask the assistant for drafts and summaries, within what they can already see.",
  },
  "audit.read": {
    group: "assistance",
    label: "Read the audit trail",
    description:
      "See who did what and when, across the whole organisation — including every change made on this screen.",
  },
  "report.export": {
    group: "assistance",
    label: "Export reports",
    description:
      "Download a report as a spreadsheet. It covers only what they can already see, never more.",
  },
  "notification.read": {
    group: "assistance",
    label: "Receive notifications",
    description: "Get in-app and push notifications about the things that concern them.",
  },
  "chat.use": {
    group: "announcements",
    label: "Use chat",
    description:
      "Send and read direct messages with colleagues. Taking this away is how one person is removed from chat without switching it off for everybody.",
  },
  "chat.export": {
    group: "announcements",
    label: "Export a conversation",
    description:
      "Download two people's private messages, with a written reason recorded against your name on this organisation's audit log. Both of them are told.",
    sensitive: true,
  },
};

const GROUPS: { key: GroupKey; title: string; description: string }[] = [
  {
    key: "organisation",
    title: "Organisation",
    description: "Settings, structure, billing, and the data allowed to leave the building.",
  },
  {
    key: "people",
    title: "People",
    description: "Who may see and change employee records — including what they are paid.",
  },
  {
    key: "attendance",
    title: "Attendance",
    description: "Marking days, correcting them, and the rules they are judged against.",
  },
  {
    key: "leave",
    title: "Leave",
    description: "Applying, approving, and the balances all of it is counted from.",
  },
  {
    key: "payroll",
    title: "Pay",
    description: "Nearly everything here either moves money or reveals what somebody earns.",
  },
  {
    key: "documents",
    title: "Documents",
    description: "Uploading, reading and deleting files, identity documents among them.",
  },
  {
    key: "letters",
    title: "Letters",
    description: "Letters issued in the organisation's name, and the templates behind them.",
  },
  {
    key: "announcements",
    title: "Announcements and recognition",
    description: "The noticeboard, and the Employee of the Month award.",
  },
  {
    key: "workflows",
    title: "Joining, exit, expenses and reviews",
    description: "The processes around somebody's time here, from their first day to the settlement.",
  },
  {
    key: "assistance",
    title: "Assistant, audit and reports",
    description: "The AI assistant, the audit trail, exports and notifications.",
  },
];

/**
 * The permissions a person in an organisation can actually be given.
 *
 * `platform.*` is dropped rather than shown and disabled: `effectivePermissions`
 * discards those grants for every role but SUPERADMIN, so a row for one would be
 * a control that looks real, saves happily, and does nothing whatsoever.
 */
const ORG_PERMISSIONS: Permission[] = PERMISSIONS.filter(
  (permission) => PERMISSION_META[permission].group !== "platform",
);

/* -------------------------------------------------------------------------- */
/*  Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type PermissionValue = "grant" | "revoke" | "inherit";

export interface PermissionRow {
  permission: Permission;
  label: string;
  description: string;
  sensitive: boolean;
  /** The role bundle includes it. */
  fromRole: boolean;
  /** The stored override for this person, if there is one. */
  override: "grant" | "revoke" | null;
  /** What the guards will answer, from the same function the guards use. */
  effective: boolean;
  /** Whether the person making the change holds it themselves. */
  actorHolds: boolean;
  /** What each option would result in — computed, never guessed. */
  outcomes: Record<PermissionValue, boolean>;
  /** The options this caller may actually choose. */
  allowed: PermissionValue[];
  /** Why the others are missing, in a sentence. */
  restriction: string | null;
}

export interface PermissionGroup {
  key: string;
  title: string;
  description: string;
  rows: PermissionRow[];
}

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: SystemRole;
  roleLabel: string;
  status: string;
  /** Overrides that make a difference: added on top of the role. */
  added: number;
  /** Overrides that make a difference: taken away from the role. */
  removed: number;
}

export interface UserPickerView {
  users: UserSummary[];
  /**
   * Logins in this organisation that are deliberately not offered: the caller
   * themselves, anybody at or above their own role, and office devices.
   */
  restricted: number;
}

export interface UserPermissionView {
  user: UserSummary;
  groups: PermissionGroup[];
  /** How many permissions the role gives, and how many are in force after overrides. */
  fromRole: number;
  effective: number;
  added: number;
  removed: number;
  /** Overrides that say exactly what the role already said, so change nothing. */
  redundant: number;
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The people this caller may adjust.
 *
 * Anybody they may not is counted rather than listed. A name and a role is no
 * secret inside one organisation, but a picker full of entries that refuse every
 * click teaches people to ignore refusals; a count and one sentence say the same
 * thing without the noise.
 */
export async function listManageableUsers(ctx: AuthContext): Promise<UserPickerView> {
  requireOrg(ctx);
  requirePermission(ctx, "org.settings.write");

  const users = await prisma.user.findMany({
    where: { organizationId: ctx.organizationId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      permissionGrants: { select: { permission: true, granted: true } },
    },
    orderBy: [{ name: "asc" }],
  });

  const manageable: UserSummary[] = [];

  for (const user of users) {
    const role = user.role as SystemRole;
    if (user.id === ctx.userId) continue;
    if (role === "SUPERADMIN" || role === "KIOSK") continue;
    if (!canManageRole(ctx.role, role)) continue;

    const roleSet = new Set<Permission>(ROLE_PERMISSIONS[role]);
    let added = 0;
    let removed = 0;
    for (const grant of user.permissionGrants) {
      const permission = grant.permission as Permission;
      // A row naming a permission that no longer exists — `platform.export.manage`
      // was deleted from the catalogue — is inert, and counting it would put a
      // badge on somebody nobody has ever adjusted.
      if (!ORG_PERMISSIONS.includes(permission)) continue;
      const inRole = roleSet.has(permission);
      if (grant.granted && !inRole) added++;
      if (!grant.granted && inRole) removed++;
    }

    manageable.push({
      id: user.id,
      name: user.name,
      email: user.email,
      role,
      roleLabel: ROLE_LABELS[role],
      status: user.status,
      added,
      removed,
    });
  }

  return { users: manageable, restricted: users.length - manageable.length };
}

/**
 * Every permission, three ways: what the role says, what has been overridden for
 * this person, and what applies as a result.
 *
 * Guarded on the same permission as the write. There is no read-only audience
 * for this screen — seeing that somebody was handed `payroll.disburse` is as
 * sensitive as the act of handing it over — and splitting the two would leave a
 * viewer facing a page of controls every one of which refuses.
 */
export async function listUserPermissions(
  ctx: AuthContext,
  userId: string,
): Promise<UserPermissionView> {
  requireOrg(ctx);
  requirePermission(ctx, "org.settings.write");

  const user = await loadTarget(ctx, userId);
  const role = user.role as SystemRole;
  const grants = user.permissionGrants;

  const roleSet = new Set<Permission>(ROLE_PERMISSIONS[role]);
  const effective = effectivePermissions(role, grants);
  const overrides = new Map(grants.map((g) => [g.permission, g.granted]));

  const rows = ORG_PERMISSIONS.map((permission) => describePermission(role, grants, permission, ctx.permissions));

  const groups: PermissionGroup[] = GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    description: group.description,
    rows: rows.filter((row) => PERMISSION_META[row.permission].group === group.key),
  })).filter((group) => group.rows.length > 0);

  const added = rows.filter((r) => r.override === "grant" && !r.fromRole).length;
  const removed = rows.filter((r) => r.override === "revoke" && r.fromRole).length;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role,
      roleLabel: ROLE_LABELS[role],
      status: user.status,
      added,
      removed,
    },
    groups,
    fromRole: roleSet.size,
    effective: effective.size,
    added,
    removed,
    // An override saying what the role already said changes nothing today, and
    // is not a mistake: it survives a change of role. Worth counting, because
    // otherwise it reads as a bug in the screen.
    redundant: [...overrides.keys()].filter((permission) => {
      const key = permission as Permission;
      if (!ORG_PERMISSIONS.includes(key)) return false;
      return overrides.get(permission) === roleSet.has(key);
    }).length,
  };
}

/* -------------------------------------------------------------------------- */
/*  Writing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sets one permission for one person.
 *
 * `inherit` deletes the row, which is not the same as `revoke`: a revocation
 * survives a change of role and keeps taking the permission away, while
 * inheriting means "whatever the role says, now and in future".
 */
export async function setUserPermission(
  ctx: AuthContext,
  userId: string,
  permission: string,
  value: PermissionValue,
): Promise<PermissionRow> {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const key = asOrgPermission(permission);
  const user = await loadTarget(ctx, userId);
  const role = user.role as SystemRole;
  const grants = user.permissionGrants;

  const before = describePermission(role, grants, key, ctx.permissions);
  const willHold = outcomeOf(role, grants, key, value);

  // The rule this whole service exists to enforce. It is not "you may not press
  // Give" — it is "this change must not leave them holding something you do
  // not", which also catches clearing a revocation to restore a permission.
  if (willHold && !ctx.permissions.has(key)) {
    throw new ForbiddenError(
      `You cannot give somebody a permission you do not have yourself. Ask an administrator who has "${PERMISSION_META[key].label}" to make this change.`,
    );
  }

  const nextOverride: "grant" | "revoke" | null = value === "inherit" ? null : value;
  if (before.override === nextOverride) {
    // Nothing to write, and nothing worth an audit row. Returning the current
    // state keeps the caller's screen honest rather than reporting a save that
    // never happened.
    return before;
  }

  if (value === "inherit") {
    // `deleteMany`, not `delete`: a row that has already gone is the outcome
    // being asked for, not an error.
    await prisma.userPermissionGrant.deleteMany({ where: { userId: user.id, permission: key } });
  } else {
    await prisma.userPermissionGrant.upsert({
      where: { userId_permission: { userId: user.id, permission: key } },
      create: { userId: user.id, permission: key, granted: value === "grant" },
      update: { granted: value === "grant" },
    });
  }

  const nextGrants = [
    ...grants.filter((g) => g.permission !== key),
    ...(value === "inherit" ? [] : [{ permission: key, granted: value === "grant" }]),
  ];
  const after = describePermission(role, nextGrants, key, ctx.permissions);

  await writeAudit(ctx, {
    action: "user.permission_changed",
    entityType: "User",
    entityId: user.id,
    before: { permission: key, override: before.override, effective: before.effective },
    after: { permission: key, override: after.override, effective: after.effective },
    metadata: {
      user: user.email,
      role,
      label: PERMISSION_META[key].label,
      sensitive: PERMISSION_META[key].sensitive ?? false,
      fromRole: after.fromRole,
    },
  });

  return after;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The four hard refusals, in one place so the read and the write cannot drift
 * apart.
 *
 * Order matters. The tenant check comes first and answers 404, because a 403
 * would confirm that a user id belonging to another organisation exists. The
 * rest are 403s, about accounts the caller can already see.
 */
async function loadTarget(ctx: AuthContext, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      organizationId: true,
      name: true,
      email: true,
      role: true,
      status: true,
      permissionGrants: { select: { permission: true, granted: true } },
    },
  });

  // Also the answer for the platform Superadmin, whose `organizationId` is null.
  assertSameTenant(ctx, user, "That user");

  if (user.id === ctx.userId) {
    throw new ForbiddenError(
      "You cannot change your own permissions. Somebody senior to you has to make the change.",
    );
  }

  const role = user.role as SystemRole;
  if (role === "SUPERADMIN") {
    throw new ForbiddenError(
      "A platform owner's permissions are not managed from inside an organisation.",
    );
  }
  if (role === "KIOSK") {
    throw new ForbiddenError(
      "An office device takes a fixed set of permissions and ignores per-person grants entirely — that is what stops an unattended screen quietly gaining the ability to read payslips. Change what a device may do by changing the device.",
    );
  }
  if (!canManageRole(ctx.role, role)) {
    throw new ForbiddenError(
      `${user.name} is ${ROLE_LABELS[role]}, which is at or above your own role. You can only adjust people junior to you.`,
    );
  }

  return user;
}

function asOrgPermission(permission: string): Permission {
  const key = permission as Permission;
  if (!ORG_PERMISSIONS.includes(key)) {
    // The `platform.*` ones land here too. Storing an unrecognised string would
    // be worse than useless: `effectivePermissions` ignores it, so the grant
    // table and the audit log would both claim something that is not true.
    throw new ValidationError(`"${permission}" is not a permission that can be given to a person.`);
  }
  return key;
}

/** What one option would leave in force, asked of the function the guards use. */
function outcomeOf(
  role: SystemRole,
  grants: readonly { permission: string; granted: boolean }[],
  permission: Permission,
  value: PermissionValue,
): boolean {
  const next = grants.filter((g) => g.permission !== permission);
  if (value !== "inherit") next.push({ permission, granted: value === "grant" });
  return effectivePermissions(role, next).has(permission);
}

/**
 * One row's three-way state — for the list, the reply, and an audit before/after.
 *
 * Takes the actor's permission set rather than their whole context, so the one
 * rule that matters can be tested without a database: everything this function
 * decides, it decides from these four arguments.
 */
export function describePermission(
  role: SystemRole,
  grants: readonly { permission: string; granted: boolean }[],
  permission: Permission,
  actorPermissions: ReadonlySet<Permission>,
): PermissionRow {
  const meta = PERMISSION_META[permission];
  const stored = grants.find((g) => g.permission === permission);
  const actorHolds = actorPermissions.has(permission);

  const outcomes: Record<PermissionValue, boolean> = {
    grant: outcomeOf(role, grants, permission, "grant"),
    revoke: outcomeOf(role, grants, permission, "revoke"),
    inherit: outcomeOf(role, grants, permission, "inherit"),
  };

  return {
    permission,
    label: meta.label,
    description: meta.description,
    sensitive: meta.sensitive ?? false,
    fromRole: ROLE_PERMISSIONS[role].includes(permission),
    override: stored === undefined ? null : stored.granted ? "grant" : "revoke",
    effective: effectivePermissions(role, grants).has(permission),
    actorHolds,
    outcomes,
    // The escalation rule as a filter on the options rather than a refusal at
    // save time, so the screen never offers a control that is going to refuse.
    allowed: (["grant", "inherit", "revoke"] as PermissionValue[]).filter(
      (value) => actorHolds || !outcomes[value],
    ),
    restriction: actorHolds
      ? null
      : "You do not have this permission yourself, so you can only take it away — never give it.",
  };
}
