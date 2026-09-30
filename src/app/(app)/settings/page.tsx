import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  BadgeIndianRupee,
  Blocks,
  CalendarClock,
  CalendarDays,
  Building2,
  CreditCard,
  FileArchive,
  Fingerprint,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Trophy,
  MonitorSmartphone,
} from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import type { Permission } from "@/lib/auth/permissions";
import type { ModuleKey } from "@/lib/features";
import { PageHeader } from "@/components/ui/stat";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

/**
 * The settings hub.
 *
 * Cards appear on exactly the same permission-and-module pair the destination
 * itself enforces, so a card is never an invitation to a 403. AI is the one
 * exception: it is reachable with the module off, because that screen is where
 * you go to see what is configured before switching it back on.
 */
interface SettingsCard {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  permission: Permission;
  module?: ModuleKey;
}

const CARDS: SettingsCard[] = [
  {
    href: "/settings/modules",
    title: "Modules",
    description: "Switch optional parts of the product on or off for everyone.",
    icon: Blocks,
    permission: "org.settings.read",
  },
  {
    href: "/settings/ai",
    title: "AI",
    description: "OpenRouter key, model and monthly usage limit.",
    icon: Sparkles,
    permission: "ai.config.manage",
  },
  {
    href: "/settings/attendance",
    title: "Attendance rules",
    description: "Late and half-day thresholds, and where attendance may be marked.",
    icon: CalendarClock,
    // Listed on read, because the destination is readable by anyone who can see
    // settings and only the form inside it needs the write permission.
    permission: "org.settings.read",
    module: "attendance",
  },
  {
    // Its own card rather than a panel at the bottom of the attendance page,
    // where nobody looking for "how do I set up the tablet at reception" was
    // ever going to find it.
    href: "/settings/attendance#devices",
    title: "Office devices",
    description: "A shared screen people mark attendance on. Face matching is always required there.",
    icon: MonitorSmartphone,
    permission: "attendance.settings.manage",
    module: "attendance",
  },
  {
    href: "/payroll/rules",
    title: "Payroll rules",
    description: "How pay is calculated: components, thresholds and deductions.",
    icon: BadgeIndianRupee,
    permission: "payroll.rules.manage",
    module: "payroll",
  },
  {
    href: "/billing",
    title: "Billing & seats",
    description: "Your plan, seat usage and payment history.",
    icon: CreditCard,
    permission: "org.billing.manage",
  },
  {
    href: "/audit",
    title: "Audit log",
    description: "Who changed what, and when.",
    icon: ShieldCheck,
    permission: "audit.read",
  },
  {
    href: "/settings/salary",
    title: "Salary structure",
    description: "The components pay is built from, and how each one is calculated.",
    icon: BadgeIndianRupee,
    permission: "salary.structure.manage",
    module: "payroll",
  },
  {
    href: "/settings/leave-types",
    title: "Leave types",
    description: "Casual, sick, earned, unpaid — days a year, paid or not, and how they accrue.",
    icon: CalendarClock,
    permission: "leave.type.manage",
    module: "leave",
  },
  {
    href: "/settings/leave-balances",
    title: "Leave balances",
    description: "Opening balances, adjustments, and the year-end carry-forward run.",
    icon: CalendarClock,
    permission: "leave.balance.manage",
    module: "leave",
  },
  {
    href: "/settings/permissions",
    title: "Individual permissions",
    description: "Give one person something their role does not include, or take it away.",
    icon: ShieldCheck,
    permission: "org.settings.write",
  },
  {
    href: "/settings/calendar",
    title: "Calendar",
    description: "Shifts, weekly offs and holidays — what makes a day a working day.",
    icon: CalendarDays,
    permission: "org.settings.write",
    module: "attendance",
  },
  {
    href: "/recognition/settings",
    title: "Employee of the Month",
    description: "What it is decided on, and how much each thing counts.",
    icon: Trophy,
    permission: "recognition.manage",
    module: "recognition",
  },
  {
    href: "/letters/templates",
    title: "Letter templates",
    description: "A default for every letter type, and the wording your organisation uses.",
    icon: ScrollText,
    // Listed on `letter.issue` because the screen is readable by anybody who
    // sends letters; only saving a change needs `letter.template.manage`.
    permission: "letter.issue",
    module: "letters",
  },
  {
    href: "/settings/organisation",
    title: "Organisation",
    description: "Your logo and how the organisation appears to the people who use it.",
    icon: Building2,
    permission: "org.settings.write",
  },
  {
    href: "/settings/export",
    title: "Data export",
    description: "An encrypted archive of everything this organisation holds.",
    icon: FileArchive,
    permission: "org.data.export",
  },
  {
    // Personal rather than organisational, but this is where people look for
    // it. The page itself needs no permission — it only ever shows your own
    // account — so it is listed on the one everybody reaching this hub holds.
    href: "/account/security",
    title: "Your security",
    description: "Two-factor authentication, signed-in devices and sign-in history.",
    icon: Fingerprint,
    permission: "org.settings.read",
  },
];

export default async function SettingsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "org.settings.read", what: "settings" });
  if (denied) return denied;

  const cards = CARDS.filter(
    (card) =>
      ctx.permissions.has(card.permission) && (!card.module || ctx.modules.has(card.module)),
  );

  return (
    <>
      <PageHeader
        title="Settings"
        description={
          ctx.organization?.name
            ? `How ${ctx.organization.name} is configured.`
            : "How this organisation is configured."
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary hover:bg-muted"
          >
            <card.icon className="size-5 text-primary" aria-hidden />
            <p className="mt-2 text-sm font-medium">{card.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{card.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
