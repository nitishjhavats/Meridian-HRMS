"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Download, Flag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/stat";
import { Alert, EmptyState } from "@/components/ui/states";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { api, mutate } from "@/lib/client/api";
import { toast } from "@/components/ui/toast";
import { formatRelative } from "@/lib/utils";

/**
 * Reported conversations, and the one way to read one.
 *
 * Downloading is `chat.export`: a written reason, an audit row on this
 * organisation's own log, and — unless deliberately turned off, which is itself
 * recorded — a notification to both people saying it happened. That is the
 * whole of the "private unless" clause, and it is stated on the screen where
 * somebody is about to use it.
 */

interface Report {
  id: string;
  reason: string;
  /** Dates cross the server-component boundary as Date objects here. */
  createdAt: Date | string;
  reviewedAt: Date | string | null;
  reporter: { id: string; name: string };
  about: { id: string; name: string } | null;
}

export function ChatReports({ initial }: { initial: Report[] }) {
  const router = useRouter();
  const [reports, setReports] = useState(initial);
  const [exporting, setExporting] = useState<Report | null>(null);
  const [reason, setReason] = useState("");
  const [tellThem, setTellThem] = useState(true);
  const [busy, setBusy] = useState(false);

  async function download() {
    if (!exporting?.about) return;
    setBusy(true);
    try {
      const response = await fetch("/api/chat/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeAId: exporting.reporter.id,
          employeeBId: exporting.about.id,
          reason: reason.trim(),
          notifyParticipants: tellThem,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new Error(payload?.error?.message ?? "That did not work");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `conversation-${exporting.id}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      setExporting(null);
      setReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That did not work");
    } finally {
      setBusy(false);
    }
  }

  async function markReviewed(report: Report) {
    const done = await mutate(
      () => api("/api/chat/reports", { method: "POST", body: { reportId: report.id } }),
      { success: "Marked as looked at.", error: "Nothing changed" },
    );
    if (done) {
      setReports((all) =>
        all.map((r) => (r.id === report.id ? { ...r, reviewedAt: new Date() } : r)),
      );
      router.refresh();
    }
  }

  if (reports.length === 0) {
    return (
      <Section title="Nothing reported">
        <EmptyState
          icon={Flag}
          title="No conversations have been reported"
          description="Anybody can report a conversation from the chat screen, and it appears here."
        />
      </Section>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {reports.map((report) => (
          <Section
            key={report.id}
            title={`${report.reporter.name} reported ${report.about?.name ?? "a conversation"}`}
            description={formatRelative(report.createdAt)}
            action={
              report.reviewedAt ? (
                <Badge tone="success">looked at</Badge>
              ) : (
                <Badge tone="warning">waiting</Badge>
              )
            }
          >
            <div className="space-y-3 p-4">
              <p className="whitespace-pre-wrap text-sm">{report.reason}</p>
              <div className="flex flex-wrap gap-2">
                {report.about ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setExporting(report);
                      setReason("");
                      setTellThem(true);
                    }}
                  >
                    <Download className="size-4" aria-hidden />
                    Read the conversation
                  </Button>
                ) : null}
                {!report.reviewedAt ? (
                  <Button size="sm" variant="ghost" onClick={() => void markReviewed(report)}>
                    <Check className="size-4" aria-hidden />
                    Mark as looked at
                  </Button>
                ) : null}
              </div>
            </div>
          </Section>
        ))}
      </div>

      <Dialog open={exporting !== null} onOpenChange={(open) => !open && setExporting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Read this conversation</DialogTitle>
            <DialogDescription>
              You will download every message between {exporting?.reporter.name} and{" "}
              {exporting?.about?.name}.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Alert tone="warning" title="This is written to your organisation's audit log">
              Your name, the reason you give, and the fact that you read it.
            </Alert>

            <Field
              label="Why"
              htmlFor="exportReason"
              required
              hint="At least a sentence. Both of them can be told what you wrote."
            >
              <Textarea
                id="exportReason"
                rows={3}
                maxLength={1000}
                value={reason}
                placeholder="Investigating the harassment report raised on 8 September"
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>

            <div className="flex items-center gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Tell them it happened</p>
                <p className="text-xs text-muted-foreground">
                  Both people are notified, with your reason. Turning this off is itself recorded
                  &mdash; do it only when telling them would compromise an investigation.
                </p>
              </div>
              <Switch
                checked={tellThem}
                disabled={busy}
                aria-label="Tell both participants"
                onCheckedChange={setTellThem}
              />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setExporting(null)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy || reason.trim().length < 20}
              onClick={() => void download()}
            >
              Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
