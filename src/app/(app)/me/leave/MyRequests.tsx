"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import { formatDate } from "@/lib/utils";

export interface LeaveRow {
  id: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  reason: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  type: { name: string; code: string; paid: boolean };
}

const TONE = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  CANCELLED: "neutral",
} as const;

function dateRange(r: LeaveRow): string {
  return r.startDate === r.endDate
    ? formatDate(r.startDate)
    : `${formatDate(r.startDate)} → ${formatDate(r.endDate)}`;
}

export function MyRequests({ requests }: { requests: LeaveRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function cancel(id: string) {
    setBusy(id);
    const ok = await mutate(
      () => api(`/api/leave/${id}`, { method: "POST", body: { action: "cancel" } }),
      { success: "Request withdrawn.", error: "That request was not withdrawn" },
    );
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  const withdraw = (r: LeaveRow) =>
    r.status === "PENDING" ? (
      <Button size="sm" variant="ghost" loading={busy === r.id} onClick={() => cancel(r.id)}>
        <X className="size-4" aria-hidden />
        Withdraw
      </Button>
    ) : null;

  return (
    <ResponsiveList
      items={requests}
      empty={
        <EmptyState
          icon={CalendarDays}
          title="No leave requests yet"
          description="Anything you request will appear here with its status."
        />
      }
      head={
        <>
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
            <span className="font-medium">{dateRange(r)}</span>
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
          <TD>{withdraw(r)}</TD>
        </TR>
      )}
      card={(r) => (
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{dateRange(r)}</p>
            <p className="text-xs text-muted-foreground">
              {r.type.name} · {r.totalDays} day{r.totalDays === 1 ? "" : "s"}
            </p>
            {r.reason ? <p className="mt-0.5 text-xs text-muted-foreground">{r.reason}</p> : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge tone={TONE[r.status]}>{r.status.toLowerCase()}</Badge>
            {withdraw(r)}
          </div>
        </div>
      )}
    />
  );
}
