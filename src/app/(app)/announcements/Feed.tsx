"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Clock,
  Heart,
  Megaphone,
  MessageSquare,
  Pin,
  Send,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { formatRelative } from "@/lib/utils";

/**
 * The feed.
 *
 * Comments load on demand rather than with the feed: most posts are read and
 * not discussed, and fetching every thread up front would make the common case
 * pay for the rare one.
 */

export interface FeedItem {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  publishAt: string;
  expiresAt: string | null;
  published: boolean;
  commentsEnabled: boolean;
  audienceLabel: string;
  author: { name: string; role: string };
  likeCount: number;
  likedByMe: boolean;
  commentCount: number;
  live: boolean;
}

interface CommentRow {
  id: string;
  body: string;
  createdAt: string;
  parentId: string | null;
  author: { id: string; name: string };
  deleted: boolean;
  canDelete: boolean;
}

export function Feed({ items, canManage }: { items: FeedItem[]; canManage: boolean }) {
  const router = useRouter();
  const [likes, setLikes] = useState<Record<string, { count: number; mine: boolean }>>({});
  const [openComments, setOpenComments] = useState<string | null>(null);
  const [comments, setComments] = useState<Record<string, CommentRow[]>>({});
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  function likeState(item: FeedItem) {
    return likes[item.id] ?? { count: item.likeCount, mine: item.likedByMe };
  }

  async function toggleLike(item: FeedItem) {
    const current = likeState(item);
    // Optimistic: a like is trivially reversible and waiting for a round trip
    // to see a heart fill in feels broken.
    setLikes((l) => ({
      ...l,
      [item.id]: { count: current.count + (current.mine ? -1 : 1), mine: !current.mine },
    }));
    // A refusal puts the heart back *and* says why. It used to fill and
    // un-fill in silence, which on a read-only subscription -- trial over,
    // payment lapsed -- looked like a broken button rather than a closed door.
    const ok = await mutate(
      () => api(`/api/announcements/${item.id}/like`, { method: "POST" }),
      { error: "That like did not go through" },
    );
    if (ok === null) setLikes((l) => ({ ...l, [item.id]: current }));
  }

  async function loadComments(id: string) {
    if (openComments === id) {
      setOpenComments(null);
      return;
    }
    setOpenComments(id);
    setDraft("");
    if (comments[id]) return;
    try {
      const result = await api<{ comments: CommentRow[] }>(`/api/announcements/${id}/comments`);
      setComments((c) => ({ ...c, [id]: result.comments }));
    } catch {
      setComments((c) => ({ ...c, [id]: [] }));
    }
  }

  async function postComment(id: string) {
    if (!draft.trim()) return;
    setBusy(true);
    const ok = await mutate(
      () =>
        api(`/api/announcements/${id}/comments`, {
          method: "POST",
          body: { action: "add", body: draft.trim() },
        }),
      { error: "That comment was not posted" },
    );
    setBusy(false);
    if (ok !== null) {
      setDraft("");
      const result = await api<{ comments: CommentRow[] }>(`/api/announcements/${id}/comments`);
      setComments((c) => ({ ...c, [id]: result.comments }));
      router.refresh();
    }
  }

  async function removeComment(announcementId: string, commentId: string) {
    const ok = await mutate(
      () =>
        api(`/api/announcements/${announcementId}/comments`, {
          method: "POST",
          body: { action: "delete", commentId },
        }),
      { success: "Comment removed.", error: "That comment was not removed" },
    );
    if (ok !== null) {
      const result = await api<{ comments: CommentRow[] }>(
        `/api/announcements/${announcementId}/comments`,
      );
      setComments((c) => ({ ...c, [announcementId]: result.comments }));
    }
  }

  async function remove(id: string) {
    const ok = await mutate(() => api(`/api/announcements/${id}`, { method: "DELETE" }), {
      success: "Announcement deleted.",
      error: "That announcement was not deleted",
    });
    if (ok !== null) router.refresh();
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Megaphone}
        title="Nothing posted yet"
        description={
          canManage
            ? "Post the first announcement and everyone you target will be notified."
            : "Announcements from your organisation will appear here."
        }
      />
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => {
        const like = likeState(item);
        const thread = comments[item.id] ?? [];

        return (
          <li key={item.id} className="rounded-lg border border-border bg-card">
            <div className="p-4">
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                {item.pinned ? (
                  <Badge tone="primary">
                    <Pin className="size-3" aria-hidden />
                    Pinned
                  </Badge>
                ) : null}
                {!item.live ? (
                  <Badge tone="warning">
                    <Clock className="size-3" aria-hidden />
                    {item.published ? "Scheduled" : "Draft"}
                  </Badge>
                ) : null}
                {canManage ? (
                  <Badge tone="neutral">
                    <Users className="size-3" aria-hidden />
                    {item.audienceLabel}
                  </Badge>
                ) : null}
              </div>

              <h3 className="text-base font-semibold">{item.title}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {item.author.name} · {formatRelative(item.publishAt)}
              </p>
              <p className="mt-2 whitespace-pre-wrap text-sm">{item.body}</p>
            </div>

            <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
              <Button size="sm" variant="ghost" onClick={() => toggleLike(item)}>
                <Heart
                  className={`size-4 ${like.mine ? "fill-danger text-danger-text" : ""}`}
                  aria-hidden
                />
                {like.count > 0 ? like.count : "Like"}
              </Button>

              {item.commentsEnabled ? (
                <Button size="sm" variant="ghost" onClick={() => loadComments(item.id)}>
                  <MessageSquare className="size-4" aria-hidden />
                  {item.commentCount > 0 ? item.commentCount : "Comment"}
                </Button>
              ) : (
                <span className="px-2 text-xs text-muted-foreground">Comments are off</span>
              )}

              {canManage ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-danger-text"
                  onClick={() => remove(item.id)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Delete
                </Button>
              ) : null}
            </div>

            {openComments === item.id ? (
              <div className="border-t border-border p-3">
                {thread.length > 0 ? (
                  <ul className="mb-3 space-y-2">
                    {thread.map((c) => (
                      <li key={c.id} className="flex items-start justify-between gap-2 text-sm">
                        <div className="min-w-0">
                          <p className="text-xs font-medium">
                            {c.author.name}
                            <span className="ml-1.5 font-normal text-muted-foreground">
                              {formatRelative(c.createdAt)}
                            </span>
                          </p>
                          <p className={c.deleted ? "italic text-muted-foreground" : ""}>{c.body}</p>
                        </div>
                        {c.canDelete ? (
                          <button
                            type="button"
                            aria-label="Remove comment"
                            className="shrink-0 text-muted-foreground hover:text-danger-text"
                            onClick={() => removeComment(item.id, c.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mb-3 text-sm text-muted-foreground">No comments yet.</p>
                )}

                <div className="flex gap-2">
                  <Input
                    value={draft}
                    aria-label="Write a comment"
                placeholder="Write a comment"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        postComment(item.id);
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    loading={busy}
                    disabled={!draft.trim()}
                    onClick={() => postComment(item.id)}
                  >
                    <Send className="size-4" aria-hidden />
                    Post
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ composer

export function Composer({ departments }: { departments: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    body: "",
    scope: "ALL",
    departmentIds: [] as string[],
    pinned: false,
  });
  const [busy, setBusy] = useState(false);

  async function post() {
    setBusy(true);
    const ok = await mutate(
      () =>
        api("/api/announcements", {
          method: "POST",
          body: {
            title: form.title.trim(),
            body: form.body.trim(),
            pinned: form.pinned,
            audience:
              form.scope === "DEPARTMENT"
                ? { scope: "DEPARTMENT", departmentIds: form.departmentIds }
                : { scope: "ALL" },
          },
        }),
      { success: "Announcement posted.", error: "That announcement was not posted" },
    );
    setBusy(false);
    if (ok !== null) {
      setForm({ title: "", body: "", scope: "ALL", departmentIds: [], pinned: false });
      setOpen(false);
      router.refresh();
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Megaphone className="size-4" aria-hidden />
        New announcement
      </Button>
    );
  }

  const ready = form.title.trim().length >= 3 && form.body.trim().length >= 3;

  return (
    <div className="w-full space-y-3 rounded-lg border border-border bg-card p-4">
      <Input
        value={form.title}
        aria-label="Announcement title"
                placeholder="Title"
        onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
      />
      <Textarea
        rows={4}
        value={form.body}
        placeholder="What do you want everyone to know?"
        onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
      />

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="radio"
            name="scope"
            checked={form.scope === "ALL"}
            onChange={() => setForm((f) => ({ ...f, scope: "ALL" }))}
          />
          Everyone
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="radio"
            name="scope"
            checked={form.scope === "DEPARTMENT"}
            onChange={() => setForm((f) => ({ ...f, scope: "DEPARTMENT" }))}
          />
          Certain departments
        </label>
        <label className="ml-auto flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={form.pinned}
            onChange={(e) => setForm((f) => ({ ...f, pinned: e.target.checked }))}
          />
          Pin to the top
        </label>
      </div>

      {form.scope === "DEPARTMENT" ? (
        <div className="flex flex-wrap gap-1.5">
          {departments.map((d) => {
            const chosen = form.departmentIds.includes(d.id);
            return (
              <button
                key={d.id}
                type="button"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    departmentIds: chosen
                      ? f.departmentIds.filter((x) => x !== d.id)
                      : [...f.departmentIds, d.id],
                  }))
                }
                className={`rounded-md border px-2 py-1 text-xs ${
                  chosen ? "border-primary bg-primary text-primary-foreground" : "border-border"
                }`}
              >
                {d.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button
          loading={busy}
          disabled={
            !ready || (form.scope === "DEPARTMENT" && form.departmentIds.length === 0)
          }
          onClick={post}
        >
          <Send className="size-4" aria-hidden />
          Post
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
