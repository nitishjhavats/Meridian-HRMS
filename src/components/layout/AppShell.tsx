"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bell,
  MessageSquare,
  ChevronDown,
  Eye,
  LogOut,
  Menu,
  MoreHorizontal,
  Moon,
  ShieldCheck,
  UserRound,
  Sun,
  X,
} from "lucide-react";
import {
  ORG_NAV,
  PLATFORM_NAV,
  type NavSection,
  isActive,
  mobileNav,
  visibleNav,
} from "@/lib/navigation";
import type { ModuleKey } from "@/lib/features";
import { cn, initials } from "@/lib/utils";
import type { Branding } from "@/lib/branding";
import { ImpersonationBanner } from "./ImpersonationBanner";
import { useModalOverlay } from "./useModalOverlay";
import { LEGAL_PAGES } from "@/lib/legal";
import { BrandMark } from "@/components/brand/BrandMark";
import { MakerCredit } from "@/components/brand/MakerCredit";
import { Badge } from "@/components/ui/badge";

/**
 * The application shell.
 *
 * Desktop gets a persistent sidebar; mobile gets a bottom bar with the four most
 * useful destinations plus a "More" sheet. This is a different layout, not a
 * narrowed one — a sidebar squeezed onto a phone is how HR apps end up unusable
 * for the people who need them most, who are on phones.
 */

export interface ShellUser {
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  /**
   * Whether to offer the profile link at all.
   *
   * The page refuses without `org.settings.write`, and a menu item that leads
   * to a refusal is worse than no menu item — the settings hub already filters
   * its cards the same way, for the same reason.
   */
  canEditProfile: boolean;
}

export interface ShellProps {
  user: ShellUser;
  /**
   * Whose instance this is, and who built it.
   *
   * Plain data, so it crosses the RSC boundary intact. The shell used to get a
   * bare name and render a hardcoded letter beside it, which meant an
   * organisation could upload a logo and then never see it anywhere inside the
   * product it had branded.
   */
  branding: Branding;
  /**
   * Which navigation tree to render. A server component cannot hand us the
   * sections themselves — they carry icon *components*, which are not
   * serialisable across the RSC boundary — so the shell picks them itself.
   */
  variant: "org" | "platform";
  permissions: string[];
  modules: ModuleKey[];
  accessState: string;
  readOnlyView: boolean;
  /** Set when the platform owner is acting as this user. */
  impersonating?: {
    byEmail: string;
    actingAs: string;
    organizationName: string | null;
    /** ISO. The banner counts down to it and leaves on time. */
    expiresAt: string;
  } | null;
  /**
   * Unread chat messages, for the header badge.
   *
   * Chat was reachable only from the sidebar — under "More" on a phone, which
   * is two taps and a scroll from anything. It was asked for beside the bell
   * twice; this is that. Zero when the module is off, so the control simply
   * does not appear.
   */
  chatUnread?: number;
  /** Whether this shell may show chat at all. */
  chatAvailable?: boolean;
  /** Unread notifications, for the header badge. */
  unread: number;
  children: React.ReactNode;
}

export function AppShell({
  user,
  branding,
  variant,
  permissions,
  modules,
  accessState,
  readOnlyView,
  impersonating,
  unread,
  chatUnread = 0,
  chatAvailable = false,
  children,
}: ShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // The platform console belongs to no organisation, so it names the product
  // rather than falling back to it silently.
  const markTitle = variant === "platform" ? `${branding.product} Platform` : undefined;
  const [moreOpen, setMoreOpen] = useState(false);

  // Focus trap, Escape and focus restoration for the two overlays, which had
  // none of the three. See the hook for why they are not Radix dialogs yet.
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const drawerRef = useModalOverlay(drawerOpen, closeDrawer);
  const moreRef = useModalOverlay(moreOpen, closeMore);

  const sections: NavSection[] = variant === "platform" ? PLATFORM_NAV : ORG_NAV;
  const ctx = { permissions: new Set(permissions), modules: new Set(modules) };
  const visible = visibleNav(sections, ctx);
  const bottom = mobileNav(sections, ctx);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-dvh bg-background">
      {impersonating ? (
        <ImpersonationBanner
          actingAs={impersonating.actingAs}
          byEmail={impersonating.byEmail}
          organizationName={impersonating.organizationName}
          readOnly={readOnlyView}
          expiresAt={impersonating.expiresAt}
        />
      ) : readOnlyView ? (
        <div className="bg-warning px-4 py-2 text-center text-xs font-medium text-warning-foreground">
          <Eye className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
          Support view — you are seeing this organisation read-only. Every page you open is logged.
        </div>
      ) : null}

      {accessState === "TRIAL_EXPIRED" || accessState === "PAST_DUE" ? (
        <div className="bg-danger px-4 py-2 text-center text-xs font-medium text-danger-foreground">
          {accessState === "TRIAL_EXPIRED"
            ? "Your trial has ended — the app is read-only until seats are purchased."
            : "Your subscription has lapsed — the app is read-only until payment is confirmed."}{" "}
          {/* The billing page refuses anybody without `org.billing.manage`, and
              this banner is on every page for everybody. An employee sent
              there gets "You do not have access"; what they can do is ask. */}
          {ctx.permissions.has("org.billing.manage") ? (
            <Link href="/billing" className="underline underline-offset-2">
              Go to billing
            </Link>
          ) : (
            "Ask your administrator to renew."
          )}
        </div>
      ) : null}

      {/* ---------- desktop sidebar ---------- */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4">
          <BrandMark branding={branding} size="sm" title={markTitle} subtitle={user.roleLabel} />
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Main">
          <NavList sections={visible} pathname={pathname} />
        </nav>

        <UserCard user={user} onSignOut={signOut} />
        <ShellCredit branding={branding} />
      </aside>

      {/* ---------- mobile drawer ---------- */}
      {drawerOpen ? (
        <div
          ref={drawerRef}
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="fixed inset-0 z-50 lg:hidden"
        >
          <button
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          />
          <div className="absolute inset-y-0 left-0 flex w-72 flex-col bg-card shadow-xl">
            <div className="flex h-14 items-center justify-between gap-2 border-b border-border px-4">
              <BrandMark branding={branding} size="sm" title={markTitle} subtitle={user.roleLabel} />
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Close"
                className="relative p-1 before:absolute before:-inset-2 before:content-['']"
              >
                <X className="size-5" />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-4">
              <NavList sections={visible} pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
            </nav>
            <UserCard user={user} onSignOut={signOut} />
            <ShellCredit branding={branding} />
          </div>
        </div>
      ) : null}

      {/* ---------- main ---------- */}
      <div className="lg:pl-64">
        {/* `gap-1` and `px-2`, not `gap-3` and `px-4`, and only on the narrow
            end -- the padding goes back to 16px from `sm` up, where there is
            room for it. Most of the fifty pixels the maker's credit needed to
            stay on one line came from here; the rest came from the icons' own
            width. Nothing was removed from the bar. */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-1 border-b border-border bg-background/95 px-2 backdrop-blur sm:px-4">
          <button
            className="touch-target-narrow -ml-1 grid shrink-0 place-items-center rounded-md lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
          <div className="min-w-0 flex-1 lg:hidden">
            <BrandMark branding={branding} size="sm" title={markTitle} />
          </div>
          <div className="flex shrink-0 items-center">
            <ThemeToggle />
          {chatAvailable ? (
            <Link
              href="/chat"
              className="touch-target-narrow relative grid place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={
                chatUnread > 0 ? `Chat, ${chatUnread} unread` : "Chat"
              }
            >
              <MessageSquare className="size-5" aria-hidden />
              {chatUnread > 0 ? (
                <span className="absolute right-0.5 top-1 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                  {chatUnread > 99 ? "99+" : chatUnread}
                </span>
              ) : null}
            </Link>
          ) : null}
          <Link
            /* The platform console is its own route group, and `(app)` bounces a
               superadmin back to `/platform` — so this link went nowhere for the
               one person the platform notifications are written for. */
            href={variant === "platform" ? "/platform/notifications" : "/notifications"}
            className="touch-target-narrow relative grid place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          >
            <Bell className="size-5" aria-hidden />
            {unread > 0 ? (
              <span className="absolute right-0.5 top-1 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-4 text-danger-foreground">
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </Link>
          </div>
        </header>

        {/* The bottom padding clears the fixed nav *and* the home indicator.
            It used to clear only the nav, with the inset added to `body` --
            which put it outside the full-height boxes it was meant to protect
            and made every page scroll by that much. */}
        <main
          id="main"
          className="px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 lg:pb-10"
        >
          {children}
        </main>
      </div>

      {/* ---------- mobile bottom bar ---------- */}
      <nav
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-border bg-card lg:hidden"
        aria-label="Primary"
      >
        {bottom.map((item) => {
          const active = isActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium",
                active ? "text-primary" : "text-muted-foreground",
              )}
              aria-current={active ? "page" : undefined}
            >
              <item.icon className="size-5" aria-hidden />
              <span className="max-w-full truncate px-1">{item.label}</span>
            </Link>
          );
        })}
        <button
          className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium text-muted-foreground"
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
        >
          <MoreHorizontal className="size-5" aria-hidden />
          <span>More</span>
        </button>
      </nav>

      {moreOpen ? (
        <div
          ref={moreRef}
          role="dialog"
          aria-modal="true"
          aria-label="More"
          className="fixed inset-0 z-50 lg:hidden"
        >
          <button
            className="absolute inset-0 bg-black/50"
            onClick={() => setMoreOpen(false)}
            aria-label="Close"
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[75dvh] overflow-y-auto rounded-t-2xl bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
            <NavList sections={visible} pathname={pathname} onNavigate={() => setMoreOpen(false)} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NavList({
  sections,
  pathname,
  onNavigate,
}: {
  sections: NavSection[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="space-y-5">
      {sections.map((section) => (
        <div key={section.label}>
          <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {section.label}
          </p>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors",
                      // 36 px is fine under a mouse and too small under a thumb.
                      "[@media(pointer:coarse)]:min-h-11",
                      active
                        ? "bg-primary-muted font-medium text-primary"
                        : "text-foreground hover:bg-muted",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <item.icon className="size-4 shrink-0" aria-hidden />
                    <span className="truncate">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function UserCard({ user, onSignOut }: { user: ShellUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="shrink-0 border-t border-border p-3">
      <button
        className="flex w-full items-center gap-2.5 rounded-md p-2 text-left hover:bg-muted"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-muted text-xs font-semibold text-primary">
          {initials(user.name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{user.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{user.email}</span>
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="mt-1 space-y-0.5">
          <div className="px-2 py-1.5">
            <Badge tone="outline">{user.roleLabel}</Badge>
          </div>
          {user.canEditProfile ? (
            <Link
              href="/account/profile"
              className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
            >
              <UserRound className="size-4" aria-hidden />
              Your profile
            </Link>
          ) : null}
          <Link
            href="/account/security"
            className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted"
          >
            <ShieldCheck className="size-4" aria-hidden />
            Security
          </Link>
          <button
            onClick={onSignOut}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-danger-text hover:bg-danger-muted"
          >
            <LogOut className="size-4" aria-hidden />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Maker's credit, at the foot of the navigation. */
function ShellCredit({ branding }: { branding: Branding }) {
  return (
    <div className="shrink-0 border-t border-border px-4 py-2.5">
      <MakerCredit logoUrl={branding.platformLogoUrl} />
      {/* Reachable from inside the product, not only from the marketing page.
          Somebody wondering what is being kept about them is signed in, not
          browsing the front door. */}
      <nav aria-label="Legal" className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-1">
        {LEGAL_PAGES.map((page) => (
          <a
            key={page.href}
            href={page.href}
            target="_blank"
            rel="noreferrer"
            className="py-1.5 text-[10px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {page.title}
          </a>
        ))}
      </nav>
    </div>
  );
}

function ThemeToggle() {
  // Starts false on both server and client, then syncs after mount. Reading the
  // document during render would make the server and client markup disagree,
  // which React reports as a hydration failure.
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("hrms.theme", next ? "dark" : "light");
    } catch {
      // Storage blocked — the toggle still works for this session.
    }
  }

  return (
    <button
      onClick={toggle}
      className="touch-target-narrow grid place-items-center rounded-md text-muted-foreground hover:bg-muted"
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
