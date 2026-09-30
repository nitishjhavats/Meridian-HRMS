import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { PageHeader } from "@/components/ui/stat";
import { NotificationList, type NotificationItem } from "./NotificationList";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "notification.read", what: "notifications" });
  if (denied) return denied;

  // Scoped by user id alone — a notification is a private message, and there is
  // no permission anywhere that grants sight of somebody else's.
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
        description="Approvals, decisions and announcements that involve you."
      />
      <NotificationList
        initial={notifications.map((n) => ({
          ...n,
          createdAt: n.createdAt.toISOString(),
        })) as NotificationItem[]}
      />
    </>
  );
}
