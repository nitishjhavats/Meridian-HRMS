import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { diffFields } from "@/lib/audit";

/**
 * Shared audit table.
 *
 * The same component serves the platform owner and an organisation admin — what
 * differs is only which rows the caller fetched, which is decided by the tenant
 * guard rather than by this component.
 */

export interface AuditRow {
  id: string;
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  actorEmail: string | null;
  before: unknown;
  after: unknown;
  organization: { name: string } | null;
}

/**
 * One side of a change, as text.
 *
 * `String(value)` was enough while every `after` was flat. The moment a service
 * nested one -- giving somebody a login writes `{ login: { role, email } }` --
 * the row read "login: — → [object Object]", which is the audit log failing at
 * the one thing it is read for. Objects and arrays are shown as their JSON, cut
 * short so a long payload cannot widen the column (the row is `break-all` for
 * the same reason -- JSON has no spaces to wrap at); `null` and a missing side
 * stay "—", and `false` and `0` stay visible rather than falling into it.
 */
export function displayValue(value: unknown, max = 80): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  const json = JSON.stringify(value);
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}

export function AuditTable({ logs, showOrganization }: { logs: AuditRow[]; showOrganization: boolean }) {
  return (
    <ResponsiveList
      items={logs}
      empty={
        <EmptyState
          icon={ShieldCheck}
          title="Nothing logged yet"
          description="Consequential actions are recorded here as they happen."
        />
      }
      head={
        <>
          <TH>When</TH>
          <TH>Who</TH>
          <TH>Action</TH>
          <TH>Entity</TH>
          <TH>Changed</TH>
        </>
      }
      row={(log) => {
        const changes = diffFields(
          log.before as Record<string, unknown> | null,
          log.after as Record<string, unknown> | null,
        );
        return (
          <TR key={log.id}>
            <TD className="whitespace-nowrap text-xs text-muted-foreground">
              {formatDateTime(log.createdAt)}
            </TD>
            <TD className="text-xs">
              {log.actorEmail ?? "system"}
              {showOrganization && log.organization ? (
                <span className="block text-muted-foreground">{log.organization.name}</span>
              ) : null}
            </TD>
            <TD>
              <Badge tone="outline">{log.action}</Badge>
            </TD>
            <TD className="text-xs">
              {log.entityType}
              {log.entityId ? (
                <span className="block font-mono text-muted-foreground">
                  {log.entityId.slice(-8)}
                </span>
              ) : null}
            </TD>
            <TD className="text-xs">
              {changes.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <ul className="space-y-0.5">
                  {changes.slice(0, 3).map((c) => (
                    <li key={c.field} className="break-words">
                      <span className="text-muted-foreground">{c.field}:</span>{" "}
                      <span className="line-through opacity-60">{displayValue(c.before)}</span> →{" "}
                      <span className="font-medium">{displayValue(c.after)}</span>
                    </li>
                  ))}
                  {changes.length > 3 ? (
                    <li className="text-muted-foreground">+{changes.length - 3} more</li>
                  ) : null}
                </ul>
              )}
            </TD>
          </TR>
        );
      }}
      card={(log) => (
        <div key={log.id}>
          <div className="flex items-start justify-between gap-3">
            <Badge tone="outline">{log.action}</Badge>
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatRelative(log.createdAt)}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {log.actorEmail ?? "system"}
            {showOrganization && log.organization ? ` · ${log.organization.name}` : ""} ·{" "}
            {log.entityType}
          </p>
        </div>
      )}
    />
  );
}
