"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  BadgeIndianRupee,
  Bell,
  CalendarDays,
  CheckCheck,
  FileSignature,
  FileText,
  Megaphone,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { cn, formatRelative } from "@/lib/utils";

/**
 * The notification centre.
 *
 * Clicking one marks it read and follows its link in a single action, because
 * the two are the same intention — nobody wants to tick a box and then find the
 * thing it was about.
 */

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  status: "UNREAD" | "READ";
  createdAt: string;
}

/** The prefix before the dot is the area; the icon follows from that. */
const ICONS: Record<string, LucideIcon> = {
  leave: CalendarDays,
  document: FileText,
  letter: FileSignature,
  announcement: Megaphone,
  payroll: BadgeIndianRupee,
  advance: BadgeIndianRupee,
  attendance: CalendarDays,
};

function iconFor(type: string): LucideIcon {
  return ICONS[type.split(".")[0] ?? ""] ?? Bell;
}

export function NotificationList({ initial }: { initial: NotificationItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState(false);

  const unread = items.filter((n) => n.status === "UNREAD").length;

  async function open(item: NotificationItem) {
    if (item.status === "UNREAD") {
      // Optimistic: the read state is trivially recoverable and waiting for a
      // round trip before navigating makes the click feel broken.
      setItems((list) =>
        list.map((n) => (n.id === item.id ? { ...n, status: "READ" as const } : n)),
      );
      void api("/api/notifications", { method: "POST", body: { action: "read", id: item.id } })
        .then(() => router.refresh())
        .catch(() => undefined);
    }
    if (item.link) router.push(item.link);
  }

  async function readAll() {
    setBusy(true);
    const ok = await mutate(
      () => api("/api/notifications", { method: "POST", body: { action: "read-all" } }),
      { success: "All caught up.", error: "Those could not be marked read" },
    );
    setBusy(false);
    if (ok !== null) {
      setItems((list) => list.map((n) => ({ ...n, status: "READ" as const })));
      router.refresh();
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Bell}
        title="Nothing to catch up on"
        description="Leave decisions, documents, letters and announcements will show up here."
      />
    );
  }

  return (
    <>
      {unread > 0 ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            {unread} unread of {items.length}
          </p>
          <Button size="sm" variant="secondary" loading={busy} onClick={readAll}>
            <CheckCheck className="size-4" aria-hidden />
            Mark all read
          </Button>
        </div>
      ) : null}

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {items.map((item) => {
          const Icon = iconFor(item.type);
          const unreadItem = item.status === "UNREAD";

          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => open(item)}
                className={cn(
                  "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50",
                  unreadItem && "bg-primary/5",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full",
                    unreadItem ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                </span>

                <span className="min-w-0 flex-1">
                  <span className={cn("block text-sm", unreadItem && "font-medium")}>
                    {item.title}
                  </span>
                  {item.body ? (
                    <span className="block text-xs text-muted-foreground">{item.body}</span>
                  ) : null}
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {formatRelative(item.createdAt)}
                  </span>
                </span>

                {unreadItem ? (
                  <span
                    className="mt-2 size-2 shrink-0 rounded-full bg-primary"
                    aria-label="Unread"
                  />
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
