import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { requireContext } from "@/lib/auth/context";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { unreadCount } from "@/lib/notify";
import { shellBranding } from "@/lib/branding";

/**
 * Never indexed.
 *
 * Set on the layout rather than left to the root's metadata, so a page added
 * under here inherits it without anybody remembering to.
 */
export const metadata = { robots: { index: false, follow: false } };

/** Shell for the platform owner's console. */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext().catch(() => null);
  if (!ctx) redirect("/login");
  if (!ctx.isSuperadmin) redirect("/dashboard");
  // Same rule as the organisation shell: a one-time password is not a password.
  if (ctx.mustChangePassword) redirect("/change-password");

  const [unread, branding] = await Promise.all([
    unreadCount(ctx.userId),
    shellBranding(null),
  ]);

  return (
    <AppShell
      user={{
        name: ctx.name,
        email: ctx.email,
        role: ctx.role,
        roleLabel: ROLE_LABELS[ctx.role],
        // The platform console has no organisation, so no profile to edit.
        canEditProfile: false,
      }}
      branding={branding}
      variant="platform"
      permissions={[...ctx.permissions]}
      modules={[]}
      accessState="UNMETERED"
      readOnlyView={false}
      unread={unread}
    >
      {children}
    </AppShell>
  );
}
