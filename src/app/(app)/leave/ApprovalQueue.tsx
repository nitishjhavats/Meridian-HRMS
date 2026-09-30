"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import { useViewer } from "@/lib/client/useViewer";
import { formatDate } from "@/lib/utils";

/**
 * Deciding other people's leave.
 *
 * Rejection asks for a note before it will go through. "Rejected" with no
 * reason is the outcome that generates a conversation anyway; this just moves
 * that conversation to where the decision is recorded.
 *
 * "Other people's" is the point: an approver's own request is listed here as
 * well, because the list is scoped to who they can see and they can see
 * themselves, and `decideLeave` refuses it whoever holds the permission. That
 * row says it is theirs and waits, instead of offering two buttons that both
 * end in a toast.
 */

export interface QueueRow {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  type: { name: string; code: string; paid: boolean };
  employee: { id: string; code: string; name: string; designation: string | null };
}

const TONE = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
} as const;

export function ApprovalQueue({
  requests,
  viewerEmployeeId,
}: {
  requests: QueueRow[];
  /**
   * The employee record behind the viewer's login, so their own request can
   * be told apart. The page has it in its context and passing it is exact
   * from the first paint; left out, it is asked for after mount, and the row
   * is a decision's for a moment before it becomes theirs to wait on.
   */
  viewerEmployeeId?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const viewer = useViewer(viewerEmployeeId === undefined);
  const self = viewerEmployeeId !== undefined ? viewerEmployeeId : (viewer?.employeeId ?? null);

  async function decide(id: string, action: "approve" | "reject") {
    setBusy(id);
    const ok = await mutate(
      () =>
        api(`/api/leave/${id}`, {
          method: "POST",
          body: { action, ...(action === "reject" && note.trim() ? { note: note.trim() } : {}) },
        }),
      {
        success: action === "approve" ? "Leave approved." : "Leave rejected.",
        error: "That decision was not saved",
      },
    );
    setBusy(null);
    if (ok !== null) {
      setRejecting(null);
      setNote("");
      router.refresh();
    }
  }

  const actions = (r: QueueRow) => {
    if (r.status !== "PENDING") return null;

    if (self !== null && r.employee.id === self) {
      return (
        <span className="text-xs text-muted-foreground">
          Your request — waiting for someone else
        </span>
      );
    }

    if (rejecting === r.id) {
      return (
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            autoFocus
            value={note}
            aria-label="Reason for declining"
                placeholder="Why not?"
            className="h-8 w-40"
            onChange={(e) => setNote(e.target.value)}
          />
          <Button
            size="sm"
            variant="danger"
            loading={busy === r.id}
            disabled={note.trim().length === 0}
            onClick={() => decide(r.id, "reject")}
          >
            Confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setRejecting(null); setNote(""); }}>
            Cancel
          </Button>
        </div>
      );
    }

    return (
      <div className="flex gap-1.5">
        <Button size="sm" variant="success" loading={busy === r.id} onClick={() => decide(r.id, "approve")}>
          <Check className="size-4" aria-hidden />
          Approve
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setRejecting(r.id)}>
          <X className="size-4" aria-hidden />
          Reject
        </Button>
      </div>
    );
  };

  const dates = (r: QueueRow) =>
    r.startDate === r.endDate
      ? formatDate(r.startDate)
      : `${formatDate(r.startDate)} → ${formatDate(r.endDate)}`;

  return (
    <ResponsiveList
      items={requests}
      empty={
        <EmptyState
          icon={CalendarDays}
          title="Nothing to decide"
          description="Leave requests from your team will appear here."
        />
      }
      head={
        <>
          <TH>Employee</TH>
          <TH>Dates</TH>
          <TH>Type</TH>
          <TH>Days</TH>
          <TH>Status</TH>
          <TH />
        </>
      }
      row={(r) => (
        <TR key={r.id}>
          <TD>
            <span className="font-medium">{r.employee.name}</span>
            <span className="block text-xs text-muted-foreground">
              {r.employee.code}
              {r.employee.designation ? ` · ${r.employee.designation}` : ""}
            </span>
          </TD>
          <TD>
            {dates(r)}
            {r.reason ? (
              <span className="block text-xs text-muted-foreground">{r.reason}</span>
            ) : null}
          </TD>
          <TD>
            {r.type.name}
            {!r.type.paid ? <span className="text-xs text-muted-foreground"> · unpaid</span> : null}
          </TD>
          <TD className="tabular">{r.totalDays}</TD>
          <TD>
            <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
          </TD>
          <TD>{actions(r)}</TD>
        </TR>
      )}
      card={(r) => (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-medium">{r.employee.name}</p>
              <p className="text-xs text-muted-foreground">
                {dates(r)} · {r.totalDays} day{r.totalDays === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-muted-foreground">{r.type.name}</p>
              {r.reason ? <p className="mt-0.5 text-xs text-muted-foreground">{r.reason}</p> : null}
            </div>
            <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
          </div>
          {actions(r)}
        </div>
      )}
    />
  );
}
