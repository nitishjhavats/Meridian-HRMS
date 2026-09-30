import { prisma } from "./db/prisma";
import type { SystemRole } from "./auth/permissions";

/**
 * Notifications.
 *
 * In-app rows are written today. Email, WhatsApp and Web Push are expressed as
 * *channels* behind one dispatcher, so adding a transport later means writing a
 * driver — not touching the twenty call sites that raise notifications.
 *
 * A notification never blocks the operation that raised it: a leave approval must
 * succeed even if the notification write fails.
 */

export type NotificationChannel = "IN_APP" | "PUSH" | "EMAIL" | "WHATSAPP";

export interface NotificationInput {
  type: string;
  title: string;
  body?: string;
  link?: string;
  metadata?: Record<string, unknown>;
  channels?: NotificationChannel[];
}

export interface ChannelDriver {
  readonly channel: NotificationChannel;
  send(userIds: string[], input: NotificationInput): Promise<void>;
}

/** The only driver wired up today. */
const inAppDriver: ChannelDriver = {
  channel: "IN_APP",
  async send(userIds, input) {
    if (userIds.length === 0) return;

    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, organizationId: true },
    });

    await prisma.notification.createMany({
      data: users.map((user) => ({
        userId: user.id,
        organizationId: user.organizationId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        link: input.link ?? null,
        metadata: (input.metadata ?? undefined) as object | undefined,
      })),
    });
  },
};

const drivers = new Map<NotificationChannel, ChannelDriver>([["IN_APP", inAppDriver]]);

/** Registers a transport. Push/email drivers plug in here without other changes. */
export function registerDriver(driver: ChannelDriver): void {
  drivers.set(driver.channel, driver);
}

async function dispatch(userIds: string[], input: NotificationInput): Promise<void> {
  const channels = input.channels ?? ["IN_APP"];
  await Promise.all(
    channels.map(async (channel) => {
      const driver = drivers.get(channel);
      if (!driver) return;
      try {
        await driver.send(userIds, input);
      } catch (error) {
        console.error(`[notify] ${channel} driver failed`, { type: input.type, error });
      }
    }),
  );
}

export const notify = {
  /** One specific person. */
  async toUser(userId: string, input: NotificationInput): Promise<void> {
    await dispatch([userId], input);
  },

  async toUsers(userIds: string[], input: NotificationInput): Promise<void> {
    await dispatch([...new Set(userIds)], input);
  },

  /** The employee's own login, if they have one. */
  async toEmployee(employeeId: string, input: NotificationInput): Promise<void> {
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { userId: true },
    });
    if (employee?.userId) await dispatch([employee.userId], input);
  },

  /** Everyone in an organisation holding any of these roles. */
  async toOrgRoles(
    organizationId: string,
    // Every role a person can hold inside an organisation. Derived rather than
    // typed out, so a new role cannot be silently left out of a notification.
    roles: Exclude<SystemRole, "SUPERADMIN" | "KIOSK">[],
    input: NotificationInput,
  ): Promise<void> {
    const users = await prisma.user.findMany({
      where: { organizationId, role: { in: roles }, status: "ACTIVE" },
      select: { id: true },
    });
    await dispatch(
      users.map((u) => u.id),
      input,
    );
  },

  /** The platform owners. */
  async toSuperadmins(input: NotificationInput): Promise<void> {
    const users = await prisma.user.findMany({
      where: { role: "SUPERADMIN", status: "ACTIVE" },
      select: { id: true },
    });
    await dispatch(
      users.map((u) => u.id),
      input,
    );
  },
};

export async function markRead(userId: string, notificationId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { id: notificationId, userId, status: "UNREAD" },
    data: { status: "READ", readAt: new Date() },
  });
}

export async function markAllRead(userId: string): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { userId, status: "UNREAD" },
    data: { status: "READ", readAt: new Date() },
  });
  return result.count;
}

export async function unreadCount(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, status: "UNREAD" } });
}
