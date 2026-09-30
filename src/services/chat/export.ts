import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite } from "@/lib/auth/guard";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { enforce } from "@/lib/ratelimit";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { employeeName } from "@/domain/employees/name";

/**
 * One conversation, as a CSV, with a written reason.
 *
 * **Streamed, never stored.** Reusing `DataExportJob` was the obvious idea and
 * it is a dead end: `listExports`, `revealPassword` and `downloadExport` all
 * require `org.data.export`, which is owner-only — so an ADMIN would create an
 * export they could not open. Relaxing that guard to fix it would be worse.
 * With no stored file there is also no encrypted copy of a private conversation
 * sitting in object storage for a day, no passphrase to leak, and nothing for
 * the export purge to interact with.
 *
 * A transcript is at most 50 messages × 30 days × 2 people ≈ 3,000 rows of
 * text, so holding it in memory is not the problem it would be for a payroll
 * export.
 */

const MIN_REASON = 20;

export interface ConversationExport {
  fileName: string;
  /** Rows for `csvResponse`, which owns the escaping. */
  rows: (string | number | null)[][];
  messageCount: number;
}

export async function exportConversation(
  ctx: AuthContext,
  input: { employeeAId: string; employeeBId: string; reason: string; notifyParticipants?: boolean },
): Promise<ConversationExport> {
  requireOrg(ctx);
  requireWrite(ctx, "chat.export", "chat");

  // A platform owner in look-don't-touch support mode has no business reading
  // two employees' private messages. `requireWrite` already refuses a write in
  // that mode; this is a read, so it has to say so itself.
  if (ctx.readOnlyView) {
    throw new ForbiddenError("Not while you are in read-only support mode.");
  }

  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) {
    throw new ValidationError(
      "Say why, in a sentence. It goes on this organisation's audit log with your name against it.",
    );
  }

  // Reuses the existing 5/hour export limiter so one administrator cannot drain
  // every conversation in the company in an afternoon.
  await enforce("export", `chat-export:${ctx.organizationId}`);

  const sorted = [input.employeeAId, input.employeeBId].sort();
  const a = sorted[0]!;
  const b = sorted[1]!;
  const [personA, personB] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: a, organizationId: ctx.organizationId! },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, userId: true, user: { select: { name: true } } },
    }),
    prisma.employee.findFirst({
      where: { id: b, organizationId: ctx.organizationId! },
      select: { id: true, firstName: true, lastName: true, employeeCode: true, userId: true, user: { select: { name: true } } },
    }),
  ]);
  if (!personA || !personB) throw new NotFoundError("That person");

  const thread = await prisma.chatThread.findUnique({
    where: {
      organizationId_employeeAId_employeeBId: {
        organizationId: ctx.organizationId!,
        employeeAId: a,
        employeeBId: b,
      },
    },
    select: { id: true },
  });
  if (!thread) throw new NotFoundError("A conversation between those two");

  const messages = await prisma.chatMessage.findMany({
    where: { threadId: thread.id },
    select: { createdAt: true, body: true, senderId: true },
    orderBy: { createdAt: "asc" },
  });

  const nameFor = (id: string) => (id === personA.id ? employeeName(personA) : employeeName(personB));
  const rows: (string | number | null)[][] = [
    ["Sent at", "From", "Employee code", "Message"],
    ...messages.map((m) => [
      m.createdAt.toISOString(),
      nameFor(m.senderId),
      m.senderId === personA.id ? personA.employeeCode : personB.employeeCode,
      m.body,
    ]),
  ];

  await writeAudit(ctx, {
    action: "chat.conversation_exported",
    entityType: "ChatThread",
    entityId: thread.id,
    after: {
      participants: [personA.employeeCode, personB.employeeCode],
      messageCount: messages.length,
      firstAt: messages[0]?.createdAt ?? null,
      lastAt: messages[messages.length - 1]?.createdAt ?? null,
      // The reason, never the messages. `buildArchive` includes `auditLog` in
      // the organisation-wide export, so a body copied in here would leak the
      // conversation straight into the file chat is deliberately kept out of.
      reason,
      participantsNotified: input.notifyParticipants !== false,
    },
  });

  // Default on. If the promise is "private between you two unless an
  // administrator exports it with a written reason", the two of them are
  // entitled to know it happened. Turning it off is itself recorded above.
  if (input.notifyParticipants !== false) {
    for (const person of [personA, personB]) {
      if (!person.userId) continue;
      await notify.toUser(person.userId, {
        type: "chat.exported",
        title: "Your conversation was exported",
        body: `${ctx.name ?? "An administrator"} downloaded your conversation with ${nameFor(
          person.id === personA.id ? personB.id : personA.id,
        )}. Reason: ${reason}`,
        link: "/notifications",
      });
    }
  }

  return {
    fileName: `chat-${personA.employeeCode}-${personB.employeeCode}.csv`,
    rows,
    messageCount: messages.length,
  };
}
