import type { LucideIcon } from "lucide-react";
import {
  BadgeIndianRupee,
  Bell,
  Building2,
  CalendarDays,
  ClipboardCheck,
  ScanFace,
  Trophy,
  Clock,
  CreditCard,
  FileSignature,
  FileText,
  Flag,
  Gauge,
  GraduationCap,
  Hash,
  KeyRound,
  LayoutDashboard,
  Laptop,
  Megaphone,
  Receipt,
  ScrollText,
  Settings,
  ShieldCheck,
  Tag,
  Target,
  TrendingUp,
  UserMinus,
  Users,
  Wallet,
  MessageSquare,
} from "lucide-react";
import type { ModuleKey } from "./features";
import type { Permission, SystemRole } from "./auth/permissions";

/**
 * Navigation is derived, never hard-coded per role.
 *
 * An item appears only when the viewer holds the permission *and* the module is
 * live. That is the same pair the API guards check, so the sidebar can never
 * advertise something a click would then refuse.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Any one of these is enough. */
  permission?: Permission | Permission[];
  module?: ModuleKey;
  /** Shown on the mobile bottom bar (max 4 plus "More"). */
  primary?: boolean;
  exact?: boolean;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

// ------------------------------------------------------------------ platform

export const PLATFORM_NAV: NavSection[] = [
  {
    label: "Overview",
    items: [
      { href: "/platform", label: "Dashboard", icon: LayoutDashboard, primary: true, exact: true },
      {
        href: "/platform/revenue",
        label: "Revenue",
        icon: TrendingUp,
        permission: "platform.analytics.read",
        primary: true,
      },
    ],
  },
  {
    label: "Customers",
    items: [
      {
        href: "/platform/organisations",
        label: "Organisations",
        icon: Building2,
        permission: "platform.org.read",
        primary: true,
      },
      {
        href: "/platform/payments",
        label: "Payments",
        icon: CreditCard,
        permission: "platform.payment.read",
        primary: true,
      },
      // Its own prefix rather than /platform/payments/codes, so `isActive`
      // lights one entry and not two.
      {
        href: "/platform/payment-codes",
        label: "Payment codes",
        icon: Hash,
        permission: "platform.payment.approve",
      },
      { href: "/platform/coupons", label: "Coupons", icon: Tag, permission: "platform.coupon.manage" },
    ],
  },
  {
    label: "Platform",
    items: [
      {
        href: "/platform/password-resets",
        label: "Password resets",
        icon: KeyRound,
        permission: "platform.passwordreset.read",
      },
      { href: "/platform/audit", label: "Audit log", icon: ShieldCheck, permission: "audit.read" },
      {
        href: "/platform/settings",
        label: "Settings",
        icon: Settings,
        permission: "platform.settings.manage",
      },
    ],
  },
];

// ------------------------------------------------------------------ organisation

export const ORG_NAV: NavSection[] = [
  {
    label: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, primary: true, exact: true },
      // Also under Administration, and deliberately in both. Settings is the
      // second thing anybody opens on a new organisation and the last place
      // they look for it is the bottom of a long sidebar.
      { href: "/settings", label: "Settings", icon: Settings, permission: "org.settings.read" },
    ],
  },
  {
    label: "My workspace",
    items: [
      { href: "/me/attendance", label: "My attendance", icon: Clock, permission: "attendance.read.self", primary: true },
      { href: "/me/leave", label: "My leave", icon: CalendarDays, permission: "leave.read.self", primary: true, module: "leave" },
      { href: "/me/salary", label: "My salary", icon: Wallet, permission: "payroll.read.self", module: "payroll" },
      { href: "/me/documents", label: "My documents", icon: FileText, permission: "document.read.self", module: "documents" },
      { href: "/me/letters", label: "My letters", icon: ScrollText, permission: "letter.read.self", module: "letters" },
    ],
  },
  {
    label: "People",
    items: [
      {
        href: "/employees",
        label: "Employees",
        icon: Users,
        permission: ["employee.read.all", "employee.read.team"],
        primary: true,
      },
      {
        href: "/attendance",
        label: "Attendance",
        icon: ClipboardCheck,
        permission: ["attendance.read.all", "attendance.read.team"],
        module: "attendance",
      },
      {
        href: "/attendance/review",
        label: "To review",
        icon: ScanFace,
        permission: "attendance.override",
        module: "attendance",
      },
      // Gated on the one permission the PIN authority screen grants, which the
      // context folds in from role, designation and person rows -- so this is
      // shown to exactly the people the API will let issue one.
      {
        href: "/attendance/pin",
        label: "Attendance PIN",
        icon: KeyRound,
        permission: "attendance.pin.issue",
        module: "attendance",
      },
      {
        href: "/leave",
        label: "Leave requests",
        icon: CalendarDays,
        permission: ["leave.read.all", "leave.read.team"],
        module: "leave",
      },
      {
        href: "/onboarding",
        label: "Onboarding",
        icon: GraduationCap,
        permission: "onboarding.manage",
        module: "onboarding",
      },
      { href: "/exit", label: "Exits", icon: UserMinus, permission: "exit.manage", module: "exit" },
      {
        href: "/recognition",
        label: "Employee of the Month",
        icon: Trophy,
        // No permission: the whole point is that everybody can see it. The
        // module switch is what decides whether it exists at all.
        module: "recognition",
      },
    ],
  },
  {
    label: "Workplace",
    items: [
      { href: "/announcements", label: "Announcements", icon: Megaphone, permission: "announcement.read", module: "announcements" },
      // Exact, because /chat/reports is its own entry below and `isActive`
      // would otherwise light both. Chat itself has no sub-routes -- a thread
      // is `?with=`, which the exact match ignores.
      { href: "/chat", label: "Chat", icon: MessageSquare, permission: "chat.use", module: "chat", exact: true },
      // The only way to this page used to be the notification that a report
      // raises; read it once and the page was gone. Gated on `chat.export`
      // because reading a reported conversation is exporting it -- the page
      // says so in its own guard.
      { href: "/chat/reports", label: "Reported conversations", icon: Flag, permission: "chat.export", module: "chat" },
      { href: "/documents", label: "Document vault", icon: FileText, permission: "document.read.all", module: "documents" },
      { href: "/letters", label: "Letters", icon: FileSignature, permission: "letter.issue", module: "letters" },
      { href: "/assets", label: "Assets", icon: Laptop, permission: "asset.manage", module: "assets" },
      // `performance.read.self` belongs in that list, and its absence is why
      // "jisko goal assign ho usko dikhe" did not happen: an ordinary employee
      // holds only that permission, `canReach()` below needs one of the listed
      // ones, and the page itself would have admitted them. The screen existed;
      // the way to it did not.
      { href: "/performance", label: "Performance", icon: Target, permission: ["performance.manage", "performance.review", "performance.read.self"], module: "performance" },
      { href: "/reports", label: "Reports", icon: TrendingUp, permission: "report.export", module: "reports" },
    ],
  },
  {
    label: "Payroll",
    items: [
      // Both scopes. `/payroll` and `/payroll/[id]` admit `payroll.read.team`
      // and narrow every figure to the holder's reports, and the permissions
      // screen advertises it as "See their team's pay" -- but with only the
      // `.all` key here a Team Lead or Manager had no way to the page except
      // typing the URL.
      {
        href: "/payroll",
        label: "Payroll runs",
        icon: BadgeIndianRupee,
        permission: ["payroll.read.all", "payroll.read.team"],
        module: "payroll",
      },
      {
        href: "/payroll/rules",
        label: "Payroll rules",
        icon: Gauge,
        permission: "payroll.rules.manage",
        module: "payroll",
      },
      {
        href: "/payroll/advances",
        label: "Advances",
        icon: Wallet,
        permission: "advance.manage",
        module: "payroll",
      },
      {
        href: "/reimbursements",
        label: "Reimbursements",
        icon: Receipt,
        permission: ["reimbursement.approve", "reimbursement.claim"],
        module: "reimbursements",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      { href: "/billing", label: "Billing & seats", icon: CreditCard, permission: "org.billing.manage" },
      { href: "/settings", label: "Settings", icon: Settings, permission: "org.settings.read" },
      { href: "/audit", label: "Audit log", icon: ShieldCheck, permission: "audit.read" },
    ],
  },
];

export const NOTIFICATIONS_ITEM: NavItem = {
  href: "/notifications",
  label: "Notifications",
  icon: Bell,
  permission: "notification.read",
};

// ------------------------------------------------------------------ filtering

export interface NavContext {
  permissions: ReadonlySet<string>;
  modules: ReadonlySet<ModuleKey>;
}

/**
 * Whether this person can follow a link: any one of the permissions, and the
 * module live if one is named.
 *
 * Exported because the dashboard's tiles and quick links decide with the same
 * rule -- they used to keep a looser one and offered "Salary slips" with
 * payroll switched off -- and a second copy of this, however faithful, is a
 * second thing to edit.
 */
export function canReach(item: Pick<NavItem, "permission" | "module">, ctx: NavContext): boolean {
  if (item.module && !ctx.modules.has(item.module)) return false;
  if (!item.permission) return true;
  const needed = Array.isArray(item.permission) ? item.permission : [item.permission];
  return needed.some((p) => ctx.permissions.has(p));
}

export function visibleNav(sections: NavSection[], ctx: NavContext): NavSection[] {
  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => canReach(item, ctx)) }))
    .filter((section) => section.items.length > 0);
}

export function navForRole(role: SystemRole): NavSection[] {
  return role === "SUPERADMIN" ? PLATFORM_NAV : ORG_NAV;
}

/**
 * Bottom-bar items for mobile: the four most useful destinations this person
 * actually has, rather than the first four in the sidebar.
 */
export function mobileNav(sections: NavSection[], ctx: NavContext, limit = 4): NavItem[] {
  const visible = visibleNav(sections, ctx).flatMap((s) => s.items);
  const primary = visible.filter((i) => i.primary);
  return [...primary, ...visible.filter((i) => !i.primary)].slice(0, limit);
}

export function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
