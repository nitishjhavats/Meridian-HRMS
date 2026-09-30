import { prisma } from "@/lib/db/prisma";

/**
 * Messages age out after thirty days.
 *
 * This is the *only* thing in the product that removes a chat message. There is
 * no delete for a sender, an administrator or the platform owner — see the note
 * at the top of `services/chat/index.ts` — so this job is the whole of the
 * forgetting, and the UI has to say both halves: they cannot be deleted, and
 * they disappear on their own.
 *
 * Not an organisation setting, deliberately. Every other window here is either
 * a platform column or a constant, and a per-organisation knob would turn
 * "messages disappear after thirty days" into a promise the product cannot make
 * to the person typing.
 *
 * Batched, like the selfie purge: a single `deleteMany` over a large tenant's
 * year of chat holds a long lock on a table people are actively writing to.
 */

export const CHAT_RETENTION_DAYS = 30;

const BATCH = 5_000;

export async function purgeExpiredChatMessages(
  options: { retentionDays?: number; now?: Date } = {},
): Promise<{ messages: number; threads: number; cutoff: Date; retentionDays: number }> {
  const retentionDays = options.retentionDays ?? CHAT_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  let messages = 0;
  for (;;) {
    const batch = await prisma.chatMessage.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    });
    if (batch.length === 0) break;
    const result = await prisma.chatMessage.deleteMany({
      where: { id: { in: batch.map((m) => m.id) } },
    });
    messages += result.count;
    if (batch.length < BATCH) break;
  }

  // A thread whose last message has aged out is an empty row that would sit in
  // the list for ever showing a conversation that no longer exists.
  const empty = await prisma.chatThread.findMany({
    where: {
      OR: [{ lastMessageAt: { lt: cutoff } }, { lastMessageAt: null }],
      messages: { none: {} },
    },
    select: { id: true },
    take: BATCH,
  });
  const threads = empty.length
    ? (await prisma.chatThread.deleteMany({ where: { id: { in: empty.map((t) => t.id) } } })).count
    : 0;

  return { messages, threads, cutoff, retentionDays };
}
