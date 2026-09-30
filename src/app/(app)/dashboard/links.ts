import type { Permission } from "@/lib/auth/permissions";
import type { ModuleKey } from "@/lib/features";
import { canReach } from "@/lib/navigation";

/**
 * Which dashboard links this person can actually follow.
 *
 * The sidebar decides an entry with one rule -- the permission, and the module
 * if one is named -- so it never advertises a screen a click would refuse. The
 * dashboard's tiles and quick links used to decide with a different, looser
 * rule: `/me/salary` was offered to somebody whose payroll module was switched
 * off, and "Check in / out" to a login with no employee record, and both
 * landed on a designed refusal instead of the thing the card promised. The
 * sidebar's rule is `canReach`, and it is called rather than copied, so the
 * two cannot disagree again.
 */

export interface DashboardViewer {
  employeeId: string | null;
  permissions: ReadonlySet<string>;
  modules: ReadonlySet<ModuleKey>;
}

/** Any one of the permissions, and the module live if one is named. */
export function canOpen(
  viewer: DashboardViewer,
  permission: Permission | Permission[] | null,
  module?: ModuleKey,
): boolean {
  return canReach({ permission: permission ?? undefined, module }, viewer);
}

/**
 * A `/me/*` screen: the above, plus an employee record for it to be about.
 *
 * A login is not always an employee -- the owner of a new organisation is not
 * one until somebody adds them -- and every `/me` page refuses without one.
 */
export function canOpenOwn(
  viewer: DashboardViewer,
  permission: Permission | Permission[],
  module?: ModuleKey,
): boolean {
  return viewer.employeeId != null && canOpen(viewer, permission, module);
}

export interface PendingCounts {
  leaveRequests: number;
  documentDeletions: number;
  regularisations: number;
  reimbursements: number;
}

export interface ApprovalRow {
  key: keyof PendingCounts;
  href: string;
  label: string;
  count: number;
}

/**
 * The "Waiting for you" rows, in the order they are shown.
 *
 * Only rows whose destination this person can open, so the section's "N
 * pending items" counts nothing that would refuse them on the way in. A row
 * with nothing pending is left out here rather than hidden on render, for the
 * same reason: the total and the list are computed from one thing.
 */
export function approvalRows(viewer: DashboardViewer, pending: PendingCounts): ApprovalRow[] {
  const rows: (ApprovalRow & { shown: boolean })[] = [
    {
      key: "leaveRequests",
      href: "/leave",
      label: "Leave requests",
      count: pending.leaveRequests,
      shown: canOpen(viewer, ["leave.read.all", "leave.read.team"], "leave"),
    },
    {
      key: "regularisations",
      href: "/attendance",
      label: "Attendance regularisations",
      count: pending.regularisations,
      shown: canOpen(viewer, ["attendance.read.all", "attendance.read.team"], "attendance"),
    },
    {
      key: "documentDeletions",
      href: "/documents",
      label: "Document deletion requests",
      count: pending.documentDeletions,
      shown: canOpen(viewer, ["document.read.all", "document.read.team"], "documents"),
    },
    {
      key: "reimbursements",
      href: "/reimbursements",
      label: "Reimbursement claims",
      count: pending.reimbursements,
      shown: canOpen(viewer, ["reimbursement.approve", "reimbursement.claim"], "reimbursements"),
    },
  ];
  return rows
    .filter((row) => row.shown && row.count > 0)
    .map((row) => ({ key: row.key, href: row.href, label: row.label, count: row.count }));
}
