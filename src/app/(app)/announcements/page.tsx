import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { listAnnouncements } from "@/services/announcements";
import { PageHeader } from "@/components/ui/stat";
import { Composer, Feed, type FeedItem } from "./Feed";

export const metadata = { title: "Announcements" };
export const dynamic = "force-dynamic";

export default async function AnnouncementsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "announcement.read",
    module: "announcements",
    what: "announcements",
  });
  if (denied) return denied;

  const canManage =
    ctx.permissions.has("announcement.create") || ctx.permissions.has("announcement.create.team");

  const [announcements, departments] = await Promise.all([
    listAnnouncements(ctx),
    canManage
      ? prisma.department.findMany({
          where: { organizationId: ctx.organizationId! },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader
        title="Announcements"
        description="What is going on across the organisation."
        action={canManage ? <Composer departments={departments} /> : undefined}
      />
      <Feed items={announcements as FeedItem[]} canManage={canManage} />
    </>
  );
}
