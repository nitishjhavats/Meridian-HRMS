"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { formatRelative } from "@/lib/utils";

/**
 * Deletion requests waiting on HR.
 *
 * Approving destroys the file and every version of it, so the button says so
 * rather than saying "Approve" and leaving the consequence to be discovered.
 */

export interface DeletionRequest {
  id: string;
  reason: string | null;
  requestedAt: string;
  title: string;
  category: string;
  employeeName: string;
  employeeCode: string;
}

export function DeletionQueue({ requests }: { requests: DeletionRequest[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(id: string, decision: "APPROVED" | "REJECTED") {
    setBusy(id);
    const ok = await mutate(
      () => api("/api/documents/deletions", { method: "POST", body: { requestId: id, decision } }),
      {
        success: decision === "APPROVED" ? "Document deleted." : "Request declined.",
        error: "That decision was not saved",
      },
    );
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  if (requests.length === 0) return null;

  return (
    <div className="mb-4 space-y-2">
      <Alert tone="warning" title={`${requests.length} deletion request(s) waiting`}>
        Approving permanently removes the document and every earlier version of it.
      </Alert>

      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{r.title}</p>
              <p className="text-xs text-muted-foreground">
                {r.employeeName} ({r.employeeCode}) · asked {formatRelative(r.requestedAt)}
              </p>
              {r.reason ? (
                <p className="mt-0.5 text-xs text-muted-foreground">“{r.reason}”</p>
              ) : null}
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button
                size="sm"
                variant="danger"
                loading={busy === r.id}
                onClick={() => decide(r.id, "APPROVED")}
              >
                <Check className="size-4" aria-hidden />
                Delete it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => decide(r.id, "REJECTED")}>
                <X className="size-4" aria-hidden />
                Keep it
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
