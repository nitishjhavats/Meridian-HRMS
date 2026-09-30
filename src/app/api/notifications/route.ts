import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { markAllRead, markRead, unreadCount } from "@/lib/notify";

/**
 * A person's own notifications.
 *
 * Deliberately scoped by `ctx.userId` alone — there is no way to ask for
 * somebody else's, and no permission that would grant it. A notification is a
 * private message, not organisation data.
 */

const querySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = route(async (request, { ctx }) => {
  const { unreadOnly, limit } = parseQuery(request, querySchema);

  const notifications = await prisma.notification.findMany({
    where: { userId: ctx.userId, ...(unreadOnly ? { status: "UNREAD" } : {}) },
    // Unread first, then newest: the thing needing attention should not be
    // pushed off the screen by older items that happen to be more recent.
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: limit ?? 100,
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      link: true,
      status: true,
      createdAt: true,
      readAt: true,
    },
  });

  return json({
    notifications: notifications.map((n) => ({
      ...n,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt?.toISOString() ?? null,
    })),
    unread: await unreadCount(ctx.userId),
  });
});

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), id: z.string().min(1) }),
  z.object({ action: z.literal("read-all") }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, bodySchema);

  if (body.action === "read-all") {
    const count = await markAllRead(ctx.userId);
    return json({ marked: count, unread: 0 });
  }

  await markRead(ctx.userId, body.id);
  return json({ marked: 1, unread: await unreadCount(ctx.userId) });
});
