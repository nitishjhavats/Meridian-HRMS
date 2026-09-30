import { Check, GraduationCap, SkipForward } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { formatDate } from "@/lib/utils";
import type { MyOnboardingTask } from "@/services/onboarding";

/**
 * What the new joiner sees when they follow the welcome notification.
 *
 * That notification links to /onboarding, and this page was gated on
 * `onboarding.manage` — HR Manager and above — so the one person it was written
 * for could not open it. Read-only on purpose: HR ticks these off, and a joiner
 * marking their own laptop as issued would be a record of nothing.
 */
export function MyOnboarding({ tasks }: { tasks: MyOnboardingTask[] }) {
  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={GraduationCap}
        title="Nothing has been set up for you"
        description="When HR starts your onboarding, the steps and their dates appear here."
      />
    );
  }

  const done = tasks.filter((t) => t.status === "COMPLETED" || t.status === "SKIPPED").length;

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">
          HR marks each of these off as it happens. Nothing here is for you to fill in.
        </p>
        <Badge tone={done === tasks.length ? "success" : "neutral"}>
          {done}/{tasks.length} done
        </Badge>
      </div>

      <ul className="divide-y divide-border">
        {tasks.map((task) => {
          const complete = task.status === "COMPLETED" || task.status === "SKIPPED";
          return (
            <li key={task.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className={`text-sm ${complete ? "text-muted-foreground line-through" : ""}`}>
                  {task.title}
                </span>
                {task.description ? (
                  <span className="block text-xs text-muted-foreground">{task.description}</span>
                ) : null}
                {task.dueOn ? (
                  <span
                    className={`block text-xs ${task.overdue ? "text-danger-text" : "text-muted-foreground"}`}
                  >
                    {formatDate(task.dueOn)}
                  </span>
                ) : null}
              </span>

              {task.status === "COMPLETED" ? (
                <Badge tone="success">
                  <Check className="size-3" aria-hidden />
                  done
                </Badge>
              ) : null}
              {task.status === "SKIPPED" ? (
                <Badge tone="neutral">
                  <SkipForward className="size-3" aria-hidden />
                  not needed
                </Badge>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
