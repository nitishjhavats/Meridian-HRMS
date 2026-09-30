"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Ban, Flag, MessageSquare, Search, Send, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState, LoadFailed, Spinner } from "@/components/ui/states";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RequestFailed, api, mutate } from "@/lib/client/api";
import { formatDate, formatRelative } from "@/lib/utils";

/**
 * Chat.
 *
 * Polling, not websockets. The CSP allows a same-origin socket; the deployment
 * is what does not — `output: "standalone"` with no broker, and handlers spread
 * across processes, which is the same argument `lib/ratelimit.ts` makes about
 * in-memory counters. The kiosk already polls on a fifteen-second interval, so
 * this is the house pattern rather than a new one. The cost, plainly: a message
 * can take up to five seconds to appear.
 *
 * Both halves of the promise are on the screen. "Messages can't be deleted"
 * without "they disappear after thirty days" reads as a lie the first time
 * somebody watches one vanish.
 */

const LIST_POLL_MS = 20_000;
const THREAD_POLL_MS = 5_000;

interface Contact {
  employeeId: string;
  name: string;
  employeeCode: string;
  designation: string | null;
  threadId: string | null;
  lastMessageAt: string | null;
  unread: number;
  awards: number;
  blocked: boolean;
}

interface Message {
  id: string;
  body: string;
  createdAt: string;
  mine: boolean;
}

interface Conversation {
  threadId: string | null;
  other: { employeeId: string; name: string; employeeCode: string };
  messages: Message[];
  blocked: boolean;
  remainingToday: number;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

/**
 * A 4xx is an answer, and a poll that keeps asking after an answer is a bug.
 *
 * The owner of a new organisation has a login and no employee record, so
 * `/api/chat` answers 422 -- and this screen used to swallow it, show the
 * spinner, and ask again every twenty seconds for as long as the tab was open.
 * The same for a lapsed subscription (402) or a revoked permission (403).
 * A 5xx or a dropped connection is a hiccup and the next tick may well
 * succeed, so those keep polling.
 */
function isAnswer(error: unknown): boolean {
  return error instanceof RequestFailed && error.status >= 400 && error.status < 500;
}

export function ChatScreen({ initialWith }: { initialWith: string | null }) {
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [listError, setListError] = useState<unknown>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [openWith, setOpenWith] = useState<string | null>(initialWith);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [threadError, setThreadError] = useState<unknown>(null);
  const [threadAttempt, setThreadAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  /** Resolves to whether the poll should go on asking. */
  const loadContacts = useCallback(async (): Promise<boolean> => {
    try {
      const result = await api<{ contacts: Contact[] }>("/api/chat");
      setContacts(result.contacts);
      setListError(null);
      return true;
    } catch (error) {
      setListError(error);
      return !isAnswer(error);
    }
  }, []);

  const loadConversation = useCallback(async (employeeId: string): Promise<boolean> => {
    try {
      const result = await api<{ conversation: Conversation }>(
        `/api/chat?with=${encodeURIComponent(employeeId)}`,
      );
      setConversation(result.conversation);
      setThreadError(null);
      return true;
    } catch (error) {
      setThreadError(error);
      return !isAnswer(error);
    }
  }, []);

  // Both polls stop when the tab is hidden. A background tab asking every five
  // seconds for ever is the thing that makes polling expensive.
  //
  // Each poll is one effect: the first load and the interval share a `halt`,
  // so a refusal ends the asking, and a Retry (which bumps the attempt) starts
  // it afresh.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const halt = () => {
      stopped = true;
      clearInterval(timer);
    };
    const ask = () =>
      void loadContacts().then((keep) => {
        if (!keep) halt();
      });
    timer = setInterval(() => {
      if (!stopped && document.visibilityState === "visible") ask();
    }, LIST_POLL_MS);
    ask();
    return halt;
  }, [listAttempt, loadContacts]);

  useEffect(() => {
    if (!openWith) {
      setConversation(null);
      setThreadError(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const halt = () => {
      stopped = true;
      clearInterval(timer);
    };
    const ask = () =>
      void loadConversation(openWith).then((keep) => {
        if (!keep) halt();
      });
    timer = setInterval(() => {
      if (!stopped && document.visibilityState === "visible") ask();
    }, THREAD_POLL_MS);
    ask();
    return halt;
  }, [openWith, threadAttempt, loadConversation]);

  function retryContacts() {
    setListError(null);
    setContacts(null);
    setListAttempt((n) => n + 1);
  }

  function retryConversation() {
    setThreadError(null);
    setThreadAttempt((n) => n + 1);
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conversation?.messages.length]);

  async function send() {
    if (!openWith || !draft.trim()) return;
    setSending(true);
    const result = await mutate<{ remainingToday: number }>(
      () => api("/api/chat", { method: "POST", body: { toEmployeeId: openWith, body: draft.trim() } }),
      // No success toast: a toast for every message you send is noise on a
      // screen where the message appearing *is* the confirmation.
      { error: "Not sent" },
    );
    setSending(false);
    if (result) {
      setDraft("");
      await loadConversation(openWith);
      await loadContacts();
    }
  }

  async function toggleBlock(employeeId: string, blocked: boolean) {
    const done = await mutate(
      () =>
        api("/api/chat/block", {
          method: "POST",
          body: { action: "block", employeeId, blocked },
        }),
      {
        success: blocked ? "Blocked. They are not told." : "Unblocked.",
        error: "Nothing changed",
      },
    );
    if (done) {
      await loadContacts();
      if (openWith === employeeId) await loadConversation(employeeId);
    }
  }

  async function report() {
    if (!openWith) return;
    const done = await mutate(
      () =>
        api("/api/chat/block", {
          method: "POST",
          body: { action: "report", employeeId: openWith, reason: reportReason.trim() },
        }),
      { success: "Reported. HR and your administrators can see it.", error: "Not reported" },
    );
    if (done) {
      setReporting(false);
      setReportReason("");
    }
  }

  const filtered = (contacts ?? []).filter((c) =>
    `${c.name} ${c.employeeCode} ${c.designation ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );

  /**
   * Consecutive messages from the same person, and the day they landed on.
   *
   * A bubble per message with a timestamp on every one is a wall of furniture.
   * Grouping puts the tail on the last of a run and the day on the first of a
   * date, which is how every messaging app anybody already uses reads.
   */
  const grouped = (conversation?.messages ?? []).map((message, index, all) => {
    const previous = all[index - 1];
    const day = message.createdAt.slice(0, 10);
    return {
      ...message,
      startsDay: previous === undefined || previous.createdAt.slice(0, 10) !== day,
      startsRun: previous === undefined || previous.mine !== message.mine,
      endsRun: all[index + 1] === undefined || all[index + 1]!.mine !== message.mine,
    };
  });

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:h-[calc(100dvh-11rem)] lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
      {/* ------------------------------------------------------- the list --- */}
      <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border p-2">
          {/* No label. The magnifying glass and the placeholder say it, and a
              "Search" heading above a search box is a word that earns nothing. */}
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              className="pl-8"
              value={query}
              aria-label="Search people"
              placeholder="Search"
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* A refusal replaces the list even when an earlier poll had filled
              it: the answer is not going to change, and a list nobody can
              message from is worse than the sentence saying why. A hiccup
              after a good load keeps the list; the next tick may fix it. */}
          {listError !== null && (contacts === null || isAnswer(listError)) ? (
            <div className="p-3">
              <LoadFailed
                compact
                error={listError}
                what="The people list"
                onRetry={retryContacts}
              />
            </div>
          ) : contacts === null ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Spinner /> Loading&hellip;
            </p>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title={query ? "Nobody matches that" : "Nobody to message yet"}
              description={
                query
                  ? "Try a partial name or an employee code."
                  : "People appear here once they have a login."
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((contact) => (
                <li key={contact.employeeId}>
                  <button
                    type="button"
                    onClick={() => setOpenWith(contact.employeeId)}
                    aria-current={openWith === contact.employeeId}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted aria-[current=true]:bg-muted"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <span className="truncate">{contact.name}</span>
                        {contact.awards > 0 ? (
                          <Badge
                            tone="warning"
                            title={`Employee of the Month ${contact.awards} times`}
                          >
                            <Trophy
                              className="size-3"
                              role="img"
                              aria-label="Employee of the Month"
                            />
                            {contact.awards}
                          </Badge>
                        ) : null}
                        {contact.blocked ? (
                          <Ban
                            className="size-3 shrink-0 text-muted-foreground"
                            role="img"
                            aria-label="Blocked"
                          />
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {contact.designation ?? contact.employeeCode}
                        {contact.lastMessageAt ? ` · ${formatRelative(contact.lastMessageAt)}` : ""}
                      </span>
                    </span>
                    {contact.unread > 0 ? (
                      <Badge tone="primary" aria-label={`${contact.unread} unread`}>
                        {contact.unread}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* --------------------------------------------------- conversation --- */}
      {conversation ? (
        /**
         * A conversation on a phone is the whole screen.
         *
         * It used to render *below* the contact list in the single-column grid,
         * so opening somebody meant scrolling past every colleague to reach the
         * messages, and there was no way back except scrolling up again. The
         * composer was pinned only on desktop, so on a phone it sat wherever the
         * page happened to end.
         *
         * `fixed inset-0` on small screens and nothing at all from `lg` up: one
         * pane, its own header with a back arrow, and the composer where a
         * thumb expects it. It covers the bottom nav on purpose — every
         * messaging app people already use does the same, and the back arrow is
         * the way out.
         */
        <div className="fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden border-border bg-card lg:static lg:z-auto lg:rounded-lg lg:border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] lg:pt-2">
            <button
              type="button"
              className="touch-target -ml-1 grid shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
              aria-label="Back to the list"
              onClick={() => {
                setConversation(null);
                setOpenWith(null);
              }}
            >
              <ArrowLeft className="size-5" aria-hidden />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{conversation.other.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {conversation.other.employeeCode}
              </p>
            </div>
            {/* Icons, not labels. Two words beside two glyphs on a phone push
                the other person&rsquo;s own name off the header. */}
            <Button
              size="sm"
              variant="ghost"
              aria-label="Report this conversation"
              title="Report"
              onClick={() => setReporting(true)}
            >
              <Flag className="size-4" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={conversation.blocked ? "Unblock them" : "Block them"}
              title={conversation.blocked ? "Unblock" : "Block"}
              onClick={() => void toggleBlock(conversation.other.employeeId, !conversation.blocked)}
            >
              <Ban
                className={`size-4 ${conversation.blocked ? "text-danger-text" : ""}`}
                aria-hidden
              />
            </Button>
          </div>

          {conversation.blocked ? (
            <div className="border-b border-border p-3">
              <Alert tone="warning" title="You have blocked them">
                Anything they send will not reach you, and they are not told.
              </Alert>
            </div>
          ) : null}

          {/* The poll was refused after the thread had opened, so it has
              stopped. What is on screen is what was last read, and the person
              is told rather than left thinking the other side has gone quiet. */}
          {threadError !== null && isAnswer(threadError) ? (
            <div className="border-b border-border p-3">
              <LoadFailed
                compact
                error={threadError}
                what="This conversation"
                onRetry={retryConversation}
              />
            </div>
          ) : null}

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
            {grouped.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing yet. Say something.
              </p>
            ) : (
              grouped.map((message) => (
                <div key={message.id}>
                  {message.startsDay ? (
                    <p className="py-2 text-center text-xs text-muted-foreground">
                      {formatDate(message.createdAt)}
                    </p>
                  ) : null}
                  <div className={`flex ${message.mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[80%] px-3 py-1.5 text-sm ${
                        message.mine ? "bg-primary text-primary-foreground" : "bg-muted"
                      } ${message.startsRun ? "rounded-t-2xl" : "rounded-t-md"} ${
                        message.endsRun
                          ? message.mine
                            ? "rounded-bl-2xl rounded-br-md"
                            : "rounded-br-2xl rounded-bl-md"
                          : "rounded-b-md"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{message.body}</p>
                      {/* Once per run, not once per bubble. */}
                      {message.endsRun ? (
                        <p
                          className={`mt-0.5 text-right text-[10px] ${
                            message.mine ? "text-primary-foreground/70" : "text-muted-foreground"
                          }`}
                        >
                          {time(message.createdAt)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>

          <div className="flex items-end gap-2 border-t border-border p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
            <Textarea
              aria-label={`Message ${conversation.other.name}`}
              rows={1}
              maxLength={2000}
              className="min-h-10 resize-none"
              value={draft}
              placeholder="Message"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              size="sm"
              loading={sending}
              disabled={sending || draft.trim().length === 0}
              aria-label="Send"
              title="Send"
              onClick={() => void send()}
            >
              <Send className="size-4" aria-hidden />
            </Button>
          </div>

          {/* Only when it is nearly true. "Enter sends" is a thing people learn
              once; a running count is a thing they need on the day it matters. */}
          {conversation.remainingToday <= 10 ? (
            <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
              {conversation.remainingToday} messages left today.
            </p>
          ) : null}
        </div>
      ) : openWith && threadError !== null ? (
        /**
         * The conversation could not be opened. The same full-screen pane as a
         * conversation on a phone, with the same way back, so tapping a name
         * and being refused does not look like tapping a name and nothing
         * happening.
         */
        <div className="fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden border-border bg-card lg:static lg:z-auto lg:rounded-lg lg:border">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))] lg:pt-2">
            <button
              type="button"
              className="touch-target -ml-1 grid shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
              aria-label="Back to the list"
              onClick={() => setOpenWith(null)}
            >
              <ArrowLeft className="size-5" aria-hidden />
            </button>
            <p className="min-w-0 flex-1 text-sm font-medium">Conversation</p>
          </div>
          <div className="flex min-h-0 flex-1 flex-col justify-center">
            <LoadFailed error={threadError} what="This conversation" onRetry={retryConversation} />
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-col justify-center rounded-lg border border-border bg-card p-4">
          {/**
           * The promise, once.
           *
           * It used to be on the page header, in the list description, under
           * the composer and in this empty state — four times on one screen,
           * and it was the same two sentences every time. Here is where
           * somebody reads it before they start typing, which is the only
           * moment it changes what they do.
           */}
          <EmptyState
            icon={MessageSquare}
            title="Pick somebody on the left"
            description="Messages cannot be deleted — not by you, not by an administrator — and they disappear on their own after 30 days. An administrator can export a conversation with a written reason, and you are told if they do."
          />
        </div>
      )}

      <Dialog open={reporting} onOpenChange={setReporting}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Report this conversation</DialogTitle>
            <DialogDescription>
              HR and your administrators are told. They can read the messages between you and{" "}
              {conversation?.other.name} if they need to.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Field
              label="What is wrong?"
              htmlFor="reportReason"
              required
              hint="A sentence is enough. This is what they read first."
            >
              <Textarea
                id="reportReason"
                rows={3}
                maxLength={1000}
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReporting(false)}>
              Cancel
            </Button>
            <Button disabled={reportReason.trim().length < 10} onClick={() => void report()}>
              Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
