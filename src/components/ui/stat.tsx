import * as React from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Dashboard tiles.
 *
 * A tile always shows what the number *is*, not just the number — a bare "18"
 * on a dashboard is a puzzle, not information.
 */
export function Stat({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
  href,
  delta,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: LucideIcon;
  tone?: "neutral" | "primary" | "success" | "warning" | "danger";
  href?: string;
  delta?: { value: number; label?: string };
}) {
  const tones = {
    neutral: "bg-muted text-muted-foreground",
    primary: "bg-primary-muted text-primary",
    success: "bg-success-muted text-success-text",
    warning: "bg-warning-muted text-warning-text",
    danger: "bg-danger-muted text-danger-text",
  } as const;

  const body = (
    <div className="flex items-start gap-3">
      {Icon ? (
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-lg", tones[tone])}>
          <Icon className="size-4.5" aria-hidden />
        </span>
      ) : null}
      {/* Nothing here truncates. Two tiles share a 375px screen, so after
          padding and the icon a label gets about 85px: "Active employees"
          became "Active empl..." and "August 2026 payroll" lost its word, on
          five screens, and the tile is the only place that copy appears. A
          label that wraps to two lines is still a label; a figure cut to
          "10,10,3..." is a wrong number. */}
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium leading-snug text-muted-foreground">{label}</p>
        <p className="tabular mt-0.5 text-base font-semibold leading-tight tracking-tight [overflow-wrap:anywhere] sm:text-xl">
          {value}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5">
          {delta ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-xs font-medium",
                delta.value >= 0 ? "text-success-text" : "text-danger-text",
              )}
            >
              {delta.value >= 0 ? (
                <ArrowUpRight className="size-3" aria-hidden />
              ) : (
                <ArrowDownRight className="size-3" aria-hidden />
              )}
              {Math.abs(delta.value)}%{delta.label ? ` ${delta.label}` : ""}
            </span>
          ) : null}
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </div>
    </div>
  );

  const className =
    "rounded-lg border border-border bg-card p-4 transition-colors" +
    (href ? " hover:border-primary/40 hover:bg-muted/40" : "");

  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {description ? (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {/* Wraps rather than refusing to shrink: a header with four actions is
          436 px wide, and `shrink-0` held it there on a 375 px screen. */}
      {action ? <div className="flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description ? (
            <p className="text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
