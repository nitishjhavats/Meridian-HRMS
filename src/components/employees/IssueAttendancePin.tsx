"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";

/**
 * A one-time PIN for somebody the face check cannot verify today.
 *
 * Works in both places, because `AttendancePin` was always keyed on the employee
 * rather than on a device: at the office device, and on the person's own phone
 * to clear a mark that came out unconfirmed.
 *
 * The code is read out, not sent: there is no email in this product by design,
 * and a code that travels through a chat message outlives the fifteen minutes it
 * is supposed to. It is shown large enough to read across a desk, and it stays
 * on screen until dismissed rather than disappearing on a timer.
 */
export function IssueAttendancePin({
  employeeId,
  employeeName,
}: {
  employeeId: string;
  employeeName: string;
}) {
  const [reason, setReason] = useState("");
  const [issued, setIssued] = useState<{ code: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function issue() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ code: string; expiresAt: string }>(`/api/employees/${employeeId}/attendance-pin`, {
          method: "POST",
          body: { reason: reason.trim() || undefined },
        }),
      { error: "A PIN was not issued" },
    );
    setBusy(false);
    if (result) setIssued(result);
  }

  if (issued) {
    const minutes = Math.max(
      0,
      Math.round((new Date(issued.expiresAt).getTime() - Date.now()) / 60000),
    );
    return (
      <Alert tone="success" title={`Read this to ${employeeName.split(" ")[0]}`}>
        <span className="mt-1 block text-center font-mono text-4xl font-semibold tracking-[0.3em]">
          {issued.code}
        </span>
        <span className="mt-2 block text-center">
          Works once, for the next {minutes} minutes &mdash; at the office device, or on their
          own phone to confirm a mark that came out unverified. The mark it makes is
          flagged for review.
        </span>
        <span className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
            Done
          </Button>
        </span>
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        If the face check cannot verify them — a bandage, a new beard, no photo on file
        yet — issue a code they can use instead.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-[16rem]"
          aria-label="Reason"
                placeholder="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void issue()}>
          <KeyRound className="size-4" aria-hidden />
          Issue a one-time PIN
        </Button>
      </div>
    </div>
  );
}
