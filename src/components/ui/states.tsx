import * as React from "react";
import { AlertTriangle, Inbox, Loader2, Lock, RefreshCw, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { describeLoadFailure } from "@/lib/client/loadFailure";
import { Button } from "./button";

/**
 * Loading, empty and error states.
 *
 * Every list and panel in the product uses these rather than rendering nothing,
 * so a screen never leaves a user staring at blank space wondering whether it
 * is broken or simply empty.
 */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin text-muted-foreground", className)} aria-hidden />;
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground" role="status">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} aria-hidden />;
}

export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2 p-4" aria-hidden>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className={cn("h-9 flex-1", c === 0 && "max-w-48")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="rounded-full bg-muted p-3">
        <Icon className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
  correlationId,
  action,
}: {
  title?: string;
  description?: string;
  correlationId?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="rounded-full bg-danger-muted p-3">
        <AlertTriangle className="size-6 text-danger-text" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>
        ) : null}
        {correlationId ? (
          <p className="text-xs text-muted-foreground">
            Reference <code className="rounded bg-muted px-1 py-0.5 font-mono">{correlationId}</code>
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/**
 * A fetch that did not come back, in place of the spinner it replaces.
 *
 * Nothing spins for ever. The sentence comes from `describeLoadFailure`: the
 * server's own message when it answered, "could not reach the server" when it
 * did not, and a reference id when there is one to quote. Retry is offered
 * only when trying again could change the answer -- a refusal (signed out,
 * read-only, not permitted) gets the reason and no button, because a button
 * that does nothing is the thing this exists to remove.
 *
 * `compact` is the inline form for a panel or a dialog body; the default is
 * the centred block a whole list or page section shows.
 */
export function LoadFailed({
  error,
  what,
  onRetry,
  compact = false,
}: {
  error: unknown;
  /** Named in the title: "The salary structure could not be loaded". */
  what?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const failure = describeLoadFailure(error, what);
  const retry =
    onRetry && !failure.refused ? (
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="size-4" aria-hidden />
        Try again
      </Button>
    ) : null;

  if (compact) {
    return (
      <Alert tone={failure.refused ? "warning" : "danger"} title={failure.title}>
        <p>{failure.description}</p>
        {failure.correlationId ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Reference{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{failure.correlationId}</code>
          </p>
        ) : null}
        {retry ? <div className="mt-2">{retry}</div> : null}
      </Alert>
    );
  }

  return (
    <ErrorState
      title={failure.title}
      description={failure.description}
      correlationId={failure.correlationId}
      action={retry ?? undefined}
    />
  );
}

export function PermissionDenied({ what = "this page" }: { what?: string }) {
  return (
    <EmptyState
      icon={Lock}
      title="You do not have access"
      description={`Your role does not include permission to view ${what}. Ask an administrator if you think this is wrong.`}
    />
  );
}

export function OfflineNotice() {
  return (
    <div className="flex items-center gap-2 rounded-md border border-warning bg-warning-muted px-3 py-2 text-sm text-warning-text">
      <WifiOff className="size-4 shrink-0" aria-hidden />
      <span>You are offline. Showing the last loaded data; changes cannot be saved right now.</span>
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  title?: string;
  children: React.ReactNode;
}) {
  const tones = {
    info: "border-info bg-info-muted text-foreground",
    success: "border-success bg-success-muted text-foreground",
    // `text-foreground` like the other three. `-foreground` is the on-solid
    // colour and is near-black in both themes, which on a dark tinted surface
    // came to 1.37:1 — an alert nobody could read.
    warning: "border-warning bg-warning-muted text-foreground",
    danger: "border-danger bg-danger-muted text-foreground",
  } as const;

  return (
    <div className={cn("rounded-md border px-3 py-2.5 text-sm", tones[tone])} role="alert">
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={cn(title && "mt-0.5")}>{children}</div>
    </div>
  );
}
