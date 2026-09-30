import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/AppShell";
import { requireContext } from "@/lib/auth/context";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { unreadCount } from "@/lib/notify";
import { unreadChatCount } from "@/services/chat";
import { shellBranding } from "@/lib/branding";

/**
 * Never indexed.
 *
 * Set on the layout rather than left to the root's metadata, so a page added
 * under here inherits it without anybody remembering to.
 */
export const metadata = { robots: { index: false, follow: false } };

/** Shell for every organisation-side screen. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext().catch(() => null);
  if (!ctx) redirect("/login");
  // The platform owner has no tenant, so this tree is not for them.
  if (ctx.isSuperadmin) redirect("/platform");
  // Neither is a shared office screen: it has one job and one page, and every
  // link in this shell is one whoever is standing at it should not follow.
  if (ctx.role === "KIOSK") redirect("/kiosk");
  // Somebody still on the password they were handed has not finished signing
  // in. The login response carries this flag too, but a cookie is already set
  // by then, so honouring it only in the browser leaves it one typed URL away
  // from being skipped. `/change-password` sits outside this layout, so there
  // is nothing here to loop against.
  // Not while somebody is being acted as: forcing the platform owner onto that
  // screen would invite them to set a customer's password, which is not theirs
  // to choose. `changeOwnPassword` refuses it too.
  if (ctx.mustChangePassword && !ctx.impersonating) redirect("/change-password");

  const [unread, branding, chatUnread] = await Promise.all([
    unreadCount(ctx.userId),
    shellBranding(ctx.organizationId),
    // Returns 0 rather than throwing when the module is off or the login has no
    // employee behind it, so the header renders either way.
    unreadChatCount(ctx),
  ]);
  const chatAvailable = ctx.modules.has("chat") && ctx.permissions.has("chat.use");

  return (
    <AppShell
      user={{
        name: ctx.name,
        email: ctx.email,
        role: ctx.role,
        roleLabel: ROLE_LABELS[ctx.role],
        canEditProfile: ctx.permissions.has("org.settings.write"),
      }}
      branding={branding}
      chatUnread={chatUnread}
      chatAvailable={chatAvailable}
      variant="org"
      permissions={[...ctx.permissions]}
      modules={[...ctx.modules]}
      accessState={ctx.accessState}
      readOnlyView={ctx.readOnlyView}
      impersonating={
        ctx.impersonating
          ? {
              byEmail: ctx.impersonating.byEmail,
              actingAs: ctx.name,
              organizationName: ctx.organization?.name ?? null,
              expiresAt: ctx.impersonating.expiresAt.toISOString(),
            }
          : null
      }
      unread={unread}
    >
      {children}
    </AppShell>
  );
}
