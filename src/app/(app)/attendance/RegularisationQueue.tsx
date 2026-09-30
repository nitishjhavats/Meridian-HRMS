"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ClipboardCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import { useViewer } from "@/lib/client/useViewer";
import { formatDate, formatTime } from "@/lib/utils";

/**
 * Attendance corrections waiting on a decision.
 *
 * The reviewer sees what the day says now next to what is being asked for, so
 * the decision does not require opening the grid in another tab.
 *
 * A team lead's own correction lands in this queue too -- their team scope
 * includes themselves -- and the service refuses to let anybody decide their
 * own. So that row says whose it is and offers nothing, rather than two
 * buttons that both end in a toast.
 */

export interface RegularisationItem {
  id: string;
  date: string;
  requestedStatus: string;
  requestedCheckIn: string | null;
  requestedCheckOut: string | null;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reviewNote: string | null;
  employee: { id: string; name: string; code: string };
  currentStatus: string | null;
}

const TONE = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
} as const;

const label = (status: string | null) =>
  status ? status.replaceAll("_", " ").toLowerCase() : "nothing recorded";

export function RegularisationQueue({
  requests,
  canDecide,
  viewerEmployeeId,
}: {
  requests: RegularisationItem[];
  canDecide: boolean;
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
  // A history list decides nothing, so it never needs to know who is looking.
  const viewer = useViewer(canDecide && viewerEmployeeId === undefined);
  const self = viewerEmployeeId !== undefined ? viewerEmployeeId : (viewer?.employeeId ?? null);

  async function decide(id: string, action: "approve" | "reject") {
    setBusy(id);
    const ok = await mutate(
      () =>
        api(`/api/attendance/regularisations/${id}`, {
          method: "POST",
          body: { action, ...(action === "reject" && note.trim() ? { note: note.trim() } : {}) },
        }),
      {
        success: action === "approve" ? "Attendance corrected." : "Request declined.",
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

  const actions = (r: RegularisationItem) => {
    if (!canDecide || r.status !== "PENDING") return null;

    // `decideRegularisation` refuses this whoever asks; say so instead.
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
          Decline
        </Button>
      </div>
    );
  };

  const change = (r: RegularisationItem) => (
    <>
      <span className="text-muted-foreground">{label(r.currentStatus)}</span>
      {" → "}
      <span className="font-medium">{label(r.requestedStatus)}</span>
      {r.requestedCheckIn ? (
        <span className="block text-xs text-muted-foreground">
          in {formatTime(r.requestedCheckIn)}
          {r.requestedCheckOut ? `, out ${formatTime(r.requestedCheckOut)}` : ""}
        </span>
      ) : null}
    </>
  );

  return (
    <ResponsiveList
      items={requests}
      empty={
        <EmptyState
          icon={ClipboardCheck}
          title="No corrections requested"
          description="When somebody misses a punch, their request lands here."
        />
      }
      head={
        <>
          <TH>Employee</TH>
          <TH>Date</TH>
          <TH>Change</TH>
          <TH>Reason</TH>
          <TH>Status</TH>
          <TH />
        </>
      }
      row={(r) => (
        <TR key={r.id}>
          <TD>
            <span className="font-medium">{r.employee.name}</span>
            <span className="block text-xs text-muted-foreground">{r.employee.code}</span>
          </TD>
          <TD>{formatDate(r.date)}</TD>
          <TD>{change(r)}</TD>
          <TD className="max-w-56">
            <span className="block truncate" title={r.reason}>
              {r.reason}
            </span>
            {r.reviewNote ? (
              <span className="block text-xs text-muted-foreground">“{r.reviewNote}”</span>
            ) : null}
          </TD>
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
              <p className="text-xs text-muted-foreground">{formatDate(r.date)}</p>
              <p className="mt-0.5 text-xs">{change(r)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{r.reason}</p>
            </div>
            <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
          </div>
          {actions(r)}
        </div>
      )}
    />
  );
}
