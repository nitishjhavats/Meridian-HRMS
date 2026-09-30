import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import {
  type Audience,
  type Viewer,
  describeAudience,
  isLive,
  isVisibleTo,
  parseAudience,
} from "@/domain/announcements/audience";

/**
 * The company feed.
 *
 * Targeting is resolved when the feed is read, not when the announcement is
 * written, so the audience follows people as they move between departments.
 * The cost is that the database cannot filter for us — hence the modest page
 * size and the filter in memory.
 */

const FEED_LIMIT = 100;

/**
 * Posting rights.
 *
 * Two permissions grant it — organisation-wide and team-only — and either is
 * enough to reach these routes. Which audiences each may address is a separate
 * question the audience field answers.
 */
function requirePost(ctx: AuthContext): void {
  requireOrg(ctx);
  if (
    !ctx.permissions.has("announcement.create") &&
    !ctx.permissions.has("announcement.create.team")
  ) {
    throw new ForbiddenError("You do not have permission to post announcements.");
  }
  requireWrite(ctx, "announcement.read", "announcements");
}


async function viewerFor(ctx: AuthContext): Promise<Viewer> {
  if (!ctx.employeeId) {
    return { role: ctx.role, employeeId: null, departmentId: null, workLocationId: null };
  }
  const employee = await prisma.employee.findFirst({
    where: { id: ctx.employeeId, organizationId: ctx.organizationId! },
    select: { id: true, departmentId: true, workLocationId: true },
  });
  return {
    role: ctx.role,
    employeeId: employee?.id ?? null,
    departmentId: employee?.departmentId ?? null,
    workLocationId: employee?.workLocationId ?? null,
  };
}

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  publishAt: string;
  expiresAt: string | null;
  published: boolean;
  commentsEnabled: boolean;
  audience: Audience;
  audienceLabel: string;
  author: { name: string; role: string };
  likeCount: number;
  likedByMe: boolean;
  commentCount: number;
  /** Only for someone who can edit — a scheduled or expired post. */
  live: boolean;
}

export async function listAnnouncements(ctx: AuthContext): Promise<AnnouncementRow[]> {
  requireOrg(ctx);
  requirePermission(ctx, "announcement.read");

  // An unpublished announcement is, by definition, something nobody is meant to
  // have seen yet. Whoever posts organisation-wide sees the whole queue, because
  // that is one comms desk working together; a team-scoped poster sees only
  // their own, because `announcement.create.team` was never meant to be a way
  // to read the owner's unsent draft about a restructure.
  //
  // This used to be one flag for both, so every team lead and manager in the
  // company could read every draft HR had written and not yet published --
  // while the comment here claimed they saw "their own".
  const seesEveryDraft = ctx.permissions.has("announcement.create");
  const seesOwnDrafts = ctx.permissions.has("announcement.create.team");
  const viewer = await viewerFor(ctx);

  const rows = await prisma.announcement.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: [{ pinned: "desc" }, { publishAt: "desc" }],
    take: FEED_LIMIT,
    select: {
      id: true,
      title: true,
      body: true,
      pinned: true,
      publishAt: true,
      expiresAt: true,
      published: true,
      commentsEnabled: true,
      audience: true,
      authorId: true,
      author: { select: { name: true, role: true } },
      likes: { select: { userId: true } },
      _count: { select: { comments: true } },
    },
  });

  const [departments, locations] = await Promise.all([
    prisma.department.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true },
    }),
    prisma.workLocation.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true },
    }),
  ]);
  const names = {
    departments: new Map(departments.map((d) => [d.id, d.name])),
    locations: new Map(locations.map((l) => [l.id, l.name])),
  };

  return rows
    .map((row) => {
      const audience = parseAudience(row.audience);
      const live = isLive(row);
      return {
        id: row.id,
        title: row.title,
        body: row.body,
        pinned: row.pinned,
        publishAt: row.publishAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        published: row.published,
        commentsEnabled: row.commentsEnabled,
        audience,
        audienceLabel: describeAudience(audience, names),
        author: { name: row.author.name, role: row.author.role },
        likeCount: row.likes.length,
        likedByMe: row.likes.some((l) => l.userId === ctx.userId),
        commentCount: row._count.comments,
        live,
        _visible: live && isVisibleTo(audience, viewer),
        _authorId: row.authorId,
      };
    })
    // Live and aimed at you, or yours, or you run announcements.
    .filter(
      (row) =>
        row._visible ||
        seesEveryDraft ||
        (seesOwnDrafts && row._authorId === ctx.userId),
    )
    // Neither field is part of the feed a client sees.
    .map(({ _visible, _authorId, ...row }) => row);
}

// ------------------------------------------------------------------ writing

export interface AnnouncementInput {
  title: string;
  body: string;
  audience?: Audience;
  pinned?: boolean;
  publishAt?: string;
  expiresAt?: string | null;
  commentsEnabled?: boolean;
  published?: boolean;
}

export async function createAnnouncement(ctx: AuthContext, input: AnnouncementInput) {
  requireOrg(ctx);
  requirePost(ctx);

  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < 3) throw new ValidationError("Give the announcement a title.");
  if (body.length < 3) throw new ValidationError("An announcement needs something to say.");

  const publishAt = input.publishAt ? new Date(input.publishAt) : new Date();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt <= publishAt) {
    throw new ValidationError("The expiry date must be after the publish date.");
  }

  const announcement = await prisma.announcement.create({
    data: {
      organizationId: ctx.organizationId,
      authorId: ctx.userId,
      title,
      body,
      audience: (input.audience ?? { scope: "ALL" }) as object,
      pinned: input.pinned ?? false,
      publishAt,
      expiresAt,
      commentsEnabled: input.commentsEnabled ?? true,
      published: input.published ?? true,
    },
  });

  await writeAudit(ctx, {
    action: "settings.updated",
    entityType: "Announcement",
    entityId: announcement.id,
    after: { title, audience: input.audience ?? { scope: "ALL" }, pinned: announcement.pinned },
  });

  // Only notify for something that is live now. A post scheduled for Monday
  // should not ping everyone on Saturday.
  if (isLive(announcement)) {
    await notifyAudience(ctx, announcement.id, title, parseAudience(announcement.audience));
  }

  return { id: announcement.id };
}

async function notifyAudience(
  ctx: AuthContext,
  announcementId: string,
  title: string,
  audience: Audience,
) {
  const employees = await prisma.employee.findMany({
    where: { organizationId: ctx.organizationId!, active: true, userId: { not: null } },
    select: {
      userId: true,
      id: true,
      departmentId: true,
      workLocationId: true,
      user: { select: { role: true } },
    },
  });

  const recipients = employees
    .filter((e) =>
      isVisibleTo(audience, {
        role: e.user?.role ?? "TEAM_MEMBER",
        employeeId: e.id,
        departmentId: e.departmentId,
        workLocationId: e.workLocationId,
      }),
    )
    .map((e) => e.userId)
    .filter((id): id is string => Boolean(id) && id !== ctx.userId);

  if (recipients.length === 0) return;

  await notify.toUsers(recipients, {
    type: "announcement.published",
    title: "New announcement",
    body: title,
    link: "/announcements",
    metadata: { announcementId },
  });
}

export async function updateAnnouncement(
  ctx: AuthContext,
  id: string,
  input: Partial<AnnouncementInput>,
) {
  requireOrg(ctx);
  requirePost(ctx);

  const existing = await prisma.announcement.findFirst({
    where: { id, organizationId: ctx.organizationId },
  });
  if (!existing) throw new NotFoundError("That announcement");

  const data: Record<string, unknown> = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.body !== undefined) data.body = input.body.trim();
  if (input.audience !== undefined) data.audience = input.audience as object;
  if (input.pinned !== undefined) data.pinned = input.pinned;
  if (input.commentsEnabled !== undefined) data.commentsEnabled = input.commentsEnabled;
  if (input.published !== undefined) data.published = input.published;
  if (input.publishAt !== undefined) data.publishAt = new Date(input.publishAt);
  if (input.expiresAt !== undefined) {
    data.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  }

  const updated = await prisma.announcement.update({ where: { id }, data });

  await writeAudit(ctx, {
    action: "settings.updated",
    entityType: "Announcement",
    entityId: id,
    before: { title: existing.title, pinned: existing.pinned, published: existing.published },
    after: { title: updated.title, pinned: updated.pinned, published: updated.published },
  });

  return { id };
}

export async function deleteAnnouncement(ctx: AuthContext, id: string) {
  requireOrg(ctx);
  requirePost(ctx);

  const existing = await prisma.announcement.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, title: true },
  });
  if (!existing) throw new NotFoundError("That announcement");

  await prisma.announcement.delete({ where: { id } });
  await writeAudit(ctx, {
    action: "settings.updated",
    entityType: "Announcement",
    entityId: id,
    before: { title: existing.title },
    after: { deleted: true },
  });

  return { id };
}

// ------------------------------------------------------------------ reactions

export async function toggleLike(ctx: AuthContext, announcementId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "announcement.read", "announcements");

  const announcement = await prisma.announcement.findFirst({
    where: { id: announcementId, organizationId: ctx.organizationId },
    select: { id: true },
  });
  if (!announcement) throw new NotFoundError("That announcement");

  const existing = await prisma.announcementLike.findUnique({
    where: { announcementId_userId: { announcementId, userId: ctx.userId } },
  });

  if (existing) {
    await prisma.announcementLike.delete({ where: { id: existing.id } });
    return { liked: false };
  }

  await prisma.announcementLike.create({ data: { announcementId, userId: ctx.userId } });
  return { liked: true };
}

export interface CommentRow {
  id: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  author: { id: string; name: string };
  deleted: boolean;
  /** Whether the current viewer may remove it. */
  canDelete: boolean;
}

export async function listComments(
  ctx: AuthContext,
  announcementId: string,
): Promise<CommentRow[]> {
  requireOrg(ctx);
  requirePermission(ctx, "announcement.read");

  const comments = await prisma.announcementComment.findMany({
    where: { announcementId, announcement: { organizationId: ctx.organizationId } },
    orderBy: { createdAt: "asc" },
    take: 500,
    select: {
      id: true,
      body: true,
      createdAt: true,
      parentId: true,
      deletedAt: true,
      user: { select: { id: true, name: true } },
    },
  });

  const canModerate = ctx.permissions.has("announcement.moderate");

  return comments.map((c) => ({
    id: c.id,
    // A removed comment leaves a tombstone: deleting the row would make replies
    // to it orphans, and silently vanishing text reads as a bug.
    body: c.deletedAt ? "This comment was removed." : c.body,
    createdAt: c.createdAt.toISOString(),
    parentId: c.parentId,
    author: { id: c.user.id, name: c.deletedAt ? "—" : c.user.name },
    deleted: Boolean(c.deletedAt),
    canDelete: !c.deletedAt && (canModerate || c.user.id === ctx.userId),
  }));
}

export async function addComment(
  ctx: AuthContext,
  announcementId: string,
  body: string,
  parentId?: string,
) {
  requireOrg(ctx);
  requireWrite(ctx, "announcement.read", "announcements");

  const text = body.trim();
  if (text.length === 0) throw new ValidationError("Write something first.");
  if (text.length > 2000) throw new ValidationError("That comment is too long.");

  const announcement = await prisma.announcement.findFirst({
    where: { id: announcementId, organizationId: ctx.organizationId },
    select: { id: true, commentsEnabled: true, authorId: true, title: true },
  });
  if (!announcement) throw new NotFoundError("That announcement");
  if (!announcement.commentsEnabled) {
    throw new ForbiddenError("Comments are turned off for this announcement.");
  }

  if (parentId) {
    const parent = await prisma.announcementComment.findFirst({
      where: { id: parentId, announcementId },
      select: { id: true },
    });
    if (!parent) throw new NotFoundError("That comment");
  }

  const comment = await prisma.announcementComment.create({
    data: { announcementId, userId: ctx.userId, body: text, parentId: parentId ?? null },
  });

  if (announcement.authorId !== ctx.userId) {
    await notify.toUser(announcement.authorId, {
      type: "announcement.commented",
      title: "New comment",
      body: `${ctx.name ?? "Someone"} commented on “${announcement.title}”.`,
      link: "/announcements",
    });
  }

  return { id: comment.id };
}

export async function deleteComment(ctx: AuthContext, commentId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "announcement.read", "announcements");

  const comment = await prisma.announcementComment.findFirst({
    where: { id: commentId, announcement: { organizationId: ctx.organizationId } },
    select: { id: true, userId: true, deletedAt: true },
  });
  if (!comment) throw new NotFoundError("That comment");
  if (comment.deletedAt) return { id: commentId };

  const canModerate = ctx.permissions.has("announcement.moderate");
  if (!canModerate && comment.userId !== ctx.userId) {
    throw new ForbiddenError("You can only remove your own comments.");
  }

  await prisma.announcementComment.update({
    where: { id: commentId },
    data: { deletedAt: new Date(), deletedById: ctx.userId },
  });

  return { id: commentId };
}
