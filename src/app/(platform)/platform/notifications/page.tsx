import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { PageHeader } from "@/components/ui/stat";
import {
  NotificationList,
  type NotificationItem,
} from "../../../(app)/notifications/NotificationList";

/**
 * The platform owner's own notifications.
 *
 * The bell has always rendered in this shell with a correct count —
 * `unreadCount(ctx.userId)` filters by user and nothing else, and four
 * `notify.toSuperadmins` call sites genuinely write rows with
 * `organizationId: null`. What did not exist was anywhere to land: the only
 * notifications page lives in the `(app)` route group, and that layout redirects
 * `isSuperadmin` straight back to `/platform`. So the bell showed a number,
 * clicking it bounced, and the rows could never be read or marked.
 *
 * The list component is shared rather than copied. Its data is scoped by user
 * id alone in both places, which is the whole rule: a notification is a private
 * message and no permission anywhere grants sight of somebody else's.
 */

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function PlatformNotificationsPage() {
  const ctx = await requirePageContext({ superadmin: true });
  const denied = pageGuard(ctx, { permission: "notification.read", what: "notifications" });
  if (denied) return denied;

  const notifications = await prisma.notification.findMany({
    where: { userId: ctx.userId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      link: true,
      status: true,
      createdAt: true,
    },
  });

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Payment requests, password resets and anything else needing the platform owner."
      />
      <NotificationList
        initial={
          notifications.map((n) => ({
            ...n,
            createdAt: n.createdAt.toISOString(),
          })) as NotificationItem[]
        }
      />
    </>
  );
}
