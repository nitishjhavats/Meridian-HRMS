import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { effectivePermissions } from "@/lib/auth/permissions";
import { ConflictError, NotFoundError, RateLimitError, ValidationError } from "@/lib/errors";
import { consume } from "@/lib/ratelimit";
import { notify } from "@/lib/notify";
import { todayInZone } from "@/domain/date";
import { employeeName } from "@/domain/employees/name";
import { awardCountsByEmployee } from "@/services/recognition";

/**
 * Employee-to-employee chat.
 *
 * Two promises hold this together, and they are both load-bearing:
 *
 *  1. **Nothing can delete a message.** Not the sender, not an administrator,
 *     not the platform owner. There is no delete function in this module, no
 *     route that would call one, no `deletedAt` column and no permission. That
 *     is strictly stronger than a permission check, which is one
 *     `UserPermissionGrant` row away from being satisfied. A test asserts this
 *     module exports nothing matching /delete|remove|redact|edit/.
 *
 *  2. **Everything disappears after thirty days**, by the nightly purge. Both
 *     halves have to be said in the UI together: the purge *is* a delete, and a
 *     product that only promises the first half looks like a liar the first
 *     time the second half works.
 *
 * Private between the two people. An administrator can export one conversation
 * with a written reason — see `export.ts` — which is recorded on the
 * organisation's own audit log and, by default, told to both of them.
 */

/** Longest a single message may be. Matches `@db.VarChar(2000)`. */
export const MAX_MESSAGE_LENGTH = 2000;

/**
 * One pair, one thread.
 *
 * Without a canonical order the same two people opening a conversation from
 * their own ends create two threads, and the unread count becomes something
 * nobody can reproduce.
 */
function pair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

function sideOf(thread: { employeeAId: string }, me: string): "a" | "b" {
  return thread.employeeAId === me ? "a" : "b";
}

async function requireEmployee(ctx: AuthContext): Promise<string> {
  requireOrg(ctx);
  if (!ctx.employeeId) {
    // An organisation owner has a login and no employee record, and chat is
    // between people in the directory.
    throw new ValidationError("Chat is between employees, and your login is not linked to one.");
  }
  return ctx.employeeId;
}

// ---------------------------------------------------------------- the list

export interface ChatContact {
  employeeId: string;
  name: string;
  employeeCode: string;
  designation: string | null;
  threadId: string | null;
  lastMessageAt: Date | null;
  unread: number;
  /** How many times they have been Employee of the Month. */
  awards: number;
  blocked: boolean;
}

/**
 * Everybody you can message, with what is waiting from each.
 *
 * Four queries for the whole screen, whatever the size of the organisation.
 * The unread count is the interesting one: "messages newer than *this* side's
 * cursor" cannot be written as one uniform predicate, so it becomes N `OR`
 * terms in a single grouped count — the same shape `listRegularisations`
 * already uses — over only the threads that can possibly be unread.
 */
export async function listContacts(ctx: AuthContext): Promise<ChatContact[]> {
  const me = await requireEmployee(ctx);
  // Reading is not writing: a lapsed subscription can still read its messages.
  requirePermission(ctx, "chat.use");
  requireModule(ctx, "chat");

  const [people, threads, blocks] = await Promise.all([
    prisma.employee.findMany({
      where: {
        organizationId: ctx.organizationId!,
        active: true,
        employmentState: { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] },
        // Somebody with no login will never open a message. A send button
        // beside them is a silent failure, and the bulk importer creates
        // plenty of them.
        userId: { not: null },
        id: { not: me },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        employeeCode: true,
        designation: { select: { title: true } },
        user: { select: { name: true } },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.chatThread.findMany({
      where: {
        organizationId: ctx.organizationId!,
        OR: [{ employeeAId: me }, { employeeBId: me }],
      },
      select: {
        id: true,
        employeeAId: true,
        employeeBId: true,
        lastMessageAt: true,
        aLastReadAt: true,
        bLastReadAt: true,
      },
    }),
    prisma.chatBlock.findMany({
      where: { organizationId: ctx.organizationId!, blockerId: me },
      select: { blockedId: true },
    }),
  ]);

  const byOther = new Map(
    threads.map((t) => [t.employeeAId === me ? t.employeeBId : t.employeeAId, t]),
  );

  const stale = threads
    .map((t) => ({ t, cursor: sideOf(t, me) === "a" ? t.aLastReadAt : t.bLastReadAt }))
    .filter(({ t, cursor }) => t.lastMessageAt && (!cursor || t.lastMessageAt > cursor));

  const counts =
    stale.length === 0
      ? []
      : await prisma.chatMessage.groupBy({
          by: ["threadId"],
          where: {
            organizationId: ctx.organizationId!,
            senderId: { not: me },
            OR: stale.map(({ t, cursor }) => ({
              threadId: t.id,
              ...(cursor ? { createdAt: { gt: cursor } } : {}),
            })),
          },
          _count: { _all: true },
        });

  const unreadByThread = new Map(counts.map((c) => [c.threadId, c._count._all]));
  const blocked = new Set(blocks.map((b) => b.blockedId));

  // Returns {} when the recognition module is off, so the badge simply
  // disappears rather than taking the page with it.
  const awards = await awardCountsByEmployee(
    ctx,
    people.map((p) => p.id),
  );

  return people
    .map((person) => {
      const thread = byOther.get(person.id) ?? null;
      return {
        employeeId: person.id,
        name: employeeName(person),
        employeeCode: person.employeeCode,
        designation: person.designation?.title ?? null,
        threadId: thread?.id ?? null,
        lastMessageAt: thread?.lastMessageAt ?? null,
        unread: thread ? (unreadByThread.get(thread.id) ?? 0) : 0,
        awards: awards[person.id] ?? 0,
        blocked: blocked.has(person.id),
      };
    })
    .sort((a, b) => {
      // Unread first, then most recent, then alphabetical — the order somebody
      // opening the screen is actually looking for.
      if (a.unread !== b.unread) return b.unread - a.unread;
      const at = a.lastMessageAt?.getTime() ?? 0;
      const bt = b.lastMessageAt?.getTime() ?? 0;
      if (at !== bt) return bt - at;
      return a.name.localeCompare(b.name, "en-IN");
    });
}

// ------------------------------------------------------------ one thread

export interface ChatMessageView {
  id: string;
  body: string;
  createdAt: Date;
  mine: boolean;
}

export interface ChatConversation {
  threadId: string | null;
  other: { employeeId: string; name: string; employeeCode: string };
  messages: ChatMessageView[];
  /** True when *I* have blocked them. */
  blocked: boolean;
  /** How many I have left to send today. */
  remainingToday: number;
}

export async function getConversation(
  ctx: AuthContext,
  otherEmployeeId: string,
  options: { after?: string } = {},
): Promise<ChatConversation> {
  const me = await requireEmployee(ctx);
  requirePermission(ctx, "chat.use");
  requireModule(ctx, "chat");

  const other = await prisma.employee.findFirst({
    where: { id: otherEmployeeId, organizationId: ctx.organizationId! },
    select: { id: true, firstName: true, lastName: true, employeeCode: true, user: { select: { name: true } } },
  });
  if (!other) throw new NotFoundError("That person");
  if (other.id === me) throw new ValidationError("You cannot message yourself.");

  const [a, b] = pair(me, other.id);
  const thread = await prisma.chatThread.findUnique({
    where: { organizationId_employeeAId_employeeBId: { organizationId: ctx.organizationId!, employeeAId: a, employeeBId: b } },
    select: { id: true, employeeAId: true },
  });

  const messages = thread
    ? await prisma.chatMessage.findMany({
        where: {
          threadId: thread.id,
          ...(options.after ? { id: { gt: options.after } } : {}),
        },
        select: { id: true, body: true, createdAt: true, senderId: true },
        orderBy: { createdAt: "asc" },
        take: 500,
      })
    : [];

  // Opening it is reading it. One UPDATE, whatever the length of the thread.
  // Not during a read-only support visit: that would mark the person's own
  // messages read on their behalf.
  if (thread && !ctx.readOnlyView) {
    await prisma.chatThread.update({
      where: { id: thread.id },
      data: sideOf(thread, me) === "a" ? { aLastReadAt: new Date() } : { bLastReadAt: new Date() },
    });
  }

  const [blocked, used] = await Promise.all([
    prisma.chatBlock.findUnique({
      where: { blockerId_blockedId: { blockerId: me, blockedId: other.id } },
      select: { id: true },
    }),
    sentToday(ctx, me),
  ]);

  return {
    threadId: thread?.id ?? null,
    other: { employeeId: other.id, name: employeeName(other), employeeCode: other.employeeCode },
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt,
      mine: m.senderId === me,
    })),
    blocked: Boolean(blocked),
    remainingToday: Math.max(0, 50 - used),
  };
}

/** How many this person has sent today, in the organisation's own timezone. */
async function sentToday(ctx: AuthContext, employeeId: string): Promise<number> {
  const day = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const start = new Date(`${day}T00:00:00.000Z`);
  return prisma.chatMessage.count({
    where: { organizationId: ctx.organizationId!, senderId: employeeId, createdAt: { gte: start } },
  });
}

// ----------------------------------------------------------------- send

export async function sendMessage(
  ctx: AuthContext,
  input: { toEmployeeId: string; body: string },
): Promise<{ id: string; createdAt: Date; remainingToday: number }> {
  const me = await requireEmployee(ctx);
  requireWrite(ctx, "chat.use", "chat");

  const body = input.body.trim();
  if (!body) throw new ValidationError("There is nothing to send.");
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`A message is at most ${MAX_MESSAGE_LENGTH} characters.`);
  }
  if (input.toEmployeeId === me) throw new ValidationError("You cannot message yourself.");

  const other = await prisma.employee.findFirst({
    where: {
      id: input.toEmployeeId,
      organizationId: ctx.organizationId!,
      active: true,
      employmentState: { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] },
    },
    select: { id: true, userId: true, firstName: true, lastName: true, user: { select: { name: true } } },
  });
  if (!other) throw new NotFoundError("That person");
  if (!other.userId) {
    throw new ValidationError("They have no login yet, so they would never see it.");
  }

  // The date is in the key, not the window: "fifty a day" means a calendar day
  // in the organisation's own timezone, which is what a person means by it.
  const day = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const limit = await consume("chatMessage", `${me}:${day}`);
  if (!limit.allowed) {
    throw new RateLimitError(
      limit.retryAfterSeconds,
      "You have sent 50 messages today. You can send more after midnight.",
    );
  }

  const [a, b] = pair(me, other.id);
  const now = new Date();

  const thread = await prisma.chatThread.upsert({
    where: { organizationId_employeeAId_employeeBId: { organizationId: ctx.organizationId!, employeeAId: a, employeeBId: b } },
    create: {
      organizationId: ctx.organizationId!,
      employeeAId: a,
      employeeBId: b,
      lastMessageAt: now,
      // Sending is reading your own side.
      ...(a === me ? { aLastReadAt: now } : { bLastReadAt: now }),
    },
    update: {
      lastMessageAt: now,
      ...(a === me ? { aLastReadAt: now } : { bLastReadAt: now }),
    },
    select: { id: true, employeeAId: true, aLastReadAt: true, bLastReadAt: true },
  });

  // A block is silent. The message is stored — it happened, and pretending it
  // did not would be its own kind of dishonesty — and simply never announced.
  const blocked = await prisma.chatBlock.findUnique({
    where: { blockerId_blockedId: { blockerId: other.id, blockedId: me } },
    select: { id: true },
  });

  const message = await prisma.chatMessage.create({
    data: {
      organizationId: ctx.organizationId!,
      threadId: thread.id,
      senderId: me,
      body,
    },
    select: { id: true, createdAt: true },
  });

  // Only the first unread message of a burst notifies. Fifty a day across a
  // company would bury the bell, and `Notification` has no retention window.
  if (!blocked && other.userId) {
    const theirCursor = thread.employeeAId === other.id ? thread.aLastReadAt : thread.bLastReadAt;
    const alreadyWaiting = await prisma.chatMessage.count({
      where: {
        threadId: thread.id,
        senderId: me,
        id: { not: message.id },
        ...(theirCursor ? { createdAt: { gt: theirCursor } } : {}),
      },
    });
    if (alreadyWaiting === 0) {
      await notify.toUser(other.userId, {
        type: "chat.message",
        title: `${ctx.name ?? "Somebody"} sent you a message`,
        body: body.length > 90 ? `${body.slice(0, 90)}…` : body,
        link: `/chat?with=${me}`,
      });
    }
  }

  return {
    id: message.id,
    createdAt: message.createdAt,
    remainingToday: Math.max(0, limit.remaining),
  };
}

// -------------------------------------------------------- block and report

export async function setBlocked(
  ctx: AuthContext,
  otherEmployeeId: string,
  blocked: boolean,
): Promise<{ blocked: boolean }> {
  const me = await requireEmployee(ctx);
  requireWrite(ctx, "chat.use", "chat");
  if (otherEmployeeId === me) throw new ValidationError("You cannot block yourself.");

  const other = await prisma.employee.findFirst({
    where: { id: otherEmployeeId, organizationId: ctx.organizationId! },
    select: { id: true },
  });
  if (!other) throw new NotFoundError("That person");

  if (blocked) {
    await prisma.chatBlock.upsert({
      where: { blockerId_blockedId: { blockerId: me, blockedId: other.id } },
      create: { organizationId: ctx.organizationId!, blockerId: me, blockedId: other.id },
      update: {},
    });
  } else {
    await prisma.chatBlock.deleteMany({ where: { blockerId: me, blockedId: other.id } });
  }

  // Deliberately no notification and no audit row naming the blocked person to
  // them. Somebody who is told they were blocked is somebody who escalates.
  return { blocked };
}

export async function reportConversation(
  ctx: AuthContext,
  input: { otherEmployeeId: string; reason: string },
): Promise<{ reported: true }> {
  const me = await requireEmployee(ctx);
  requireWrite(ctx, "chat.use", "chat");

  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new ValidationError("Say what is wrong, in a sentence. An administrator reads this.");
  }

  const other = await prisma.employee.findFirst({
    where: { id: input.otherEmployeeId, organizationId: ctx.organizationId! },
    select: { id: true, firstName: true, lastName: true, user: { select: { name: true } } },
  });
  if (!other) throw new NotFoundError("That person");

  const [a, b] = pair(me, other.id);
  const thread = await prisma.chatThread.findUnique({
    where: { organizationId_employeeAId_employeeBId: { organizationId: ctx.organizationId!, employeeAId: a, employeeBId: b } },
    select: { id: true },
  });
  if (!thread) throw new ConflictError("There is nothing to report — you have no messages with them.");

  await prisma.chatReport.create({
    data: {
      organizationId: ctx.organizationId!,
      threadId: thread.id,
      reporterId: me,
      reason,
    },
  });

  // HR and the administrators are all told -- the report dialog promises that.
  // But `/chat/reports` is gated on `chat.export`, which HR does not hold by
  // default, and a notification whose link lands on "You do not have access"
  // is worse than one with no link. So the link goes only to the people the
  // page will admit, decided by their effective permissions rather than by
  // role name, because a grant row can hand the permission to anybody.
  const told = await prisma.user.findMany({
    where: {
      organizationId: ctx.organizationId!,
      role: { in: ["HR_MANAGER", "ADMIN", "ORG_OWNER"] },
      status: "ACTIVE",
    },
    select: { id: true, role: true, permissionGrants: { select: { permission: true, granted: true } } },
  });
  const canOpen = told.filter((u) => effectivePermissions(u.role, u.permissionGrants).has("chat.export"));
  const cannot = told.filter((u) => !canOpen.includes(u));
  const notice = {
    type: "chat.reported",
    title: "A conversation has been reported",
    body: `${ctx.name ?? "An employee"} reported their conversation with ${employeeName(other)}. Reason: ${reason}`,
  };
  await notify.toUsers(
    canOpen.map((u) => u.id),
    { ...notice, link: "/chat/reports" },
  );
  await notify.toUsers(
    cannot.map((u) => u.id),
    notice,
  );

  return { reported: true };
}

export async function listReports(ctx: AuthContext) {
  requireOrg(ctx);
  requirePermission(ctx, "chat.export");
  requireModule(ctx, "chat");

  const reports = await prisma.chatReport.findMany({
    where: { organizationId: ctx.organizationId! },
    select: {
      id: true,
      reason: true,
      createdAt: true,
      reviewedAt: true,
      threadId: true,
      reporter: {
        select: { id: true, firstName: true, lastName: true, employeeCode: true, user: { select: { name: true } } },
      },
    },
    orderBy: [{ reviewedAt: "asc" }, { createdAt: "desc" }],
    take: 100,
  });

  const threads = await prisma.chatThread.findMany({
    where: { id: { in: reports.map((r) => r.threadId) } },
    select: {
      id: true,
      employeeA: { select: { id: true, firstName: true, lastName: true, user: { select: { name: true } } } },
      employeeB: { select: { id: true, firstName: true, lastName: true, user: { select: { name: true } } } },
    },
  });
  const byThread = new Map(threads.map((t) => [t.id, t]));

  return reports.map((r) => {
    const thread = byThread.get(r.threadId);
    const reporterId = r.reporter.id;
    const other =
      thread?.employeeA.id === reporterId ? thread?.employeeB : thread?.employeeA;
    return {
      id: r.id,
      reason: r.reason,
      createdAt: r.createdAt,
      reviewedAt: r.reviewedAt,
      reporter: { id: reporterId, name: employeeName(r.reporter) },
      about: other ? { id: other.id, name: employeeName(other) } : null,
    };
  });
}

export async function markReportReviewed(ctx: AuthContext, reportId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "chat.export", "chat");

  const report = await prisma.chatReport.findFirst({
    where: { id: reportId, organizationId: ctx.organizationId! },
    select: { id: true },
  });
  if (!report) throw new NotFoundError("That report");

  await prisma.chatReport.update({
    where: { id: reportId },
    data: { reviewedById: ctx.userId, reviewedAt: new Date() },
  });

  return { reviewed: true };
}

/**
 * How many unread messages this person has, across every conversation.
 *
 * The contact list already computes this per thread, but it also loads every
 * colleague, their award counts and the block list — far too much to render a
 * badge in a header on every page. This is the same two queries and nothing
 * else.
 *
 * Zero when the module is off or the caller has no employee record, rather than
 * throwing: the header renders for everybody, including a superadmin with no
 * organisation, and a badge is not worth a page failing over.
 */
export async function unreadChatCount(ctx: AuthContext): Promise<number> {
  if (!ctx.organizationId || !ctx.employeeId) return 0;
  if (!ctx.modules.has("chat")) return 0;
  if (!ctx.permissions.has("chat.use")) return 0;

  const me = ctx.employeeId;
  const threads = await prisma.chatThread.findMany({
    where: {
      organizationId: ctx.organizationId,
      OR: [{ employeeAId: me }, { employeeBId: me }],
      lastMessageAt: { not: null },
    },
    select: {
      id: true,
      employeeAId: true,
      employeeBId: true,
      lastMessageAt: true,
      aLastReadAt: true,
      bLastReadAt: true,
    },
  });

  // Only the threads whose newest message is newer than this side's cursor can
  // possibly hold anything unread — the same narrowing `listContacts` does, and
  // the reason this is two cheap queries rather than a scan of every message.
  const stale = threads
    .map((t) => ({ t, cursor: sideOf(t, me) === "a" ? t.aLastReadAt : t.bLastReadAt }))
    .filter(({ t, cursor }) => t.lastMessageAt && (!cursor || t.lastMessageAt > cursor));

  if (stale.length === 0) return 0;

  return prisma.chatMessage.count({
    where: {
      organizationId: ctx.organizationId,
      senderId: { not: me },
      OR: stale.map(({ t, cursor }) => ({
        threadId: t.id,
        ...(cursor ? { createdAt: { gt: cursor } } : {}),
      })),
    },
  });
}
