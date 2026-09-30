"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Download, Eye, FileArchive, Loader2 } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";
import { formatDateTime } from "@/lib/utils";
import type { ExportJobView } from "@/services/export";

/**
 * Data export.
 *
 * The password is the whole interaction. It is shown once when the export is
 * built, and typing it back is what unlocks the download — so the screen is
 * built around not letting somebody click past it.
 */

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> =
  {
    READY: { label: "Ready", tone: "success" },
    RUNNING: { label: "Building", tone: "warning" },
    QUEUED: { label: "Queued", tone: "warning" },
    FAILED: { label: "Failed", tone: "danger" },
    EXPIRED: { label: "Expired", tone: "neutral" },
  };

function size(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * `readOnly` is the platform's support view of an organisation. Listing what
 * exists is a read and is allowed; building, revealing and downloading are
 * refused by the service, so the controls are not offered rather than shown
 * and then toasted at.
 */
export function ExportPanel({ jobs, readOnly = false }: { jobs: ExportJobView[]; readOnly?: boolean }) {
  const router = useRouter();
  const [building, setBuilding] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<ExportJobView | null>(null);

  async function build() {
    setBuilding(true);
    const result = await mutate(
      () => api<{ password: string }>("/api/export", { method: "POST" }),
      { error: "The export was not built" },
    );
    setBuilding(false);
    if (result) {
      setPassword(result.password);
      router.refresh();
    }
  }

  async function reveal(job: ExportJobView) {
    const result = await mutate(
      () =>
        api<{ password: string }>(`/api/export/${job.id}`, {
          method: "POST",
          body: { action: "reveal" },
        }),
      { error: "The password could not be shown" },
    );
    if (result) setPassword(result.password);
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button onClick={build} loading={building} disabled={readOnly}>
          <FileArchive className="size-4" aria-hidden />
          Build an export
        </Button>
        {readOnly ? (
          <p className="text-sm text-muted-foreground">
            Exports cannot be built or opened from the read-only support view.
          </p>
        ) : building ? (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Reading every table — this takes a moment.
          </p>
        ) : null}
      </div>

      <div className="rounded-lg border border-border bg-card">
        <ResponsiveList
          items={jobs}
          head={
            <>
              <TH>Built</TH>
              <TH>By</TH>
              <TH>Status</TH>
              <TH numeric>Size</TH>
              <TH>Available until</TH>
              <TH />
            </>
          }
          row={(job) => (
            <TR key={job.id}>
              <TD>{formatDateTime(job.createdAt)}</TD>
              <TD>{job.requestedBy}</TD>
              <TD>
                <Badge tone={STATUS[job.status]?.tone ?? "neutral"}>
                  {STATUS[job.status]?.label ?? job.status}
                </Badge>
                {job.error ? (
                  <span className="ml-2 text-xs text-muted-foreground">{job.error}</span>
                ) : null}
              </TD>
              <TD numeric>{size(job.sizeBytes)}</TD>
              <TD>{job.expiresAt ? formatDateTime(job.expiresAt) : "—"}</TD>
              <TD className="text-right">
                {readOnly ? null : (
                  <RowActions job={job} onDownload={() => setDownloading(job)} onReveal={reveal} />
                )}
              </TD>
            </TR>
          )}
          card={(job) => (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{formatDateTime(job.createdAt)}</p>
                <Badge tone={STATUS[job.status]?.tone ?? "neutral"}>
                  {STATUS[job.status]?.label ?? job.status}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {job.requestedBy} · {size(job.sizeBytes)}
                {job.expiresAt ? ` · until ${formatDateTime(job.expiresAt)}` : ""}
              </p>
              {readOnly ? null : (
                <RowActions job={job} onDownload={() => setDownloading(job)} onReveal={reveal} />
              )}
            </div>
          )}
          empty={
            <EmptyState
              icon={FileArchive}
              title="No exports yet"
              description="An export is a snapshot of everything this organisation holds, in one encrypted file."
            />
          }
        />
      </div>

      {password ? <PasswordShown password={password} onDone={() => setPassword(null)} /> : null}
      {downloading ? (
        <DownloadDialog job={downloading} onClose={() => setDownloading(null)} />
      ) : null}
    </>
  );
}

function RowActions({
  job,
  onDownload,
  onReveal,
}: {
  job: ExportJobView;
  onDownload: () => void;
  onReveal: (job: ExportJobView) => void;
}) {
  if (!job.downloadable) return null;
  return (
    <span className="flex flex-wrap justify-end gap-1">
      {job.mine ? (
        <Button size="sm" variant="ghost" onClick={() => onReveal(job)}>
          <Eye className="size-4" aria-hidden />
          Password
        </Button>
      ) : null}
      <Button size="sm" variant="outline" onClick={onDownload}>
        <Download className="size-4" aria-hidden />
        Download
      </Button>
    </span>
  );
}

/**
 * The reveal.
 *
 * The button waits until the password has actually been copied, but closing is
 * not blocked: unlike recovery codes, this one can be shown again to the person
 * who asked for the export, so trapping them here would buy nothing.
 */
function PasswordShown({ password, onDone }: { password: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onDone())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>The password for this export</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Alert tone="warning" title="Nothing can open the file without this">
            It unlocks an archive holding every salary, every record and every person in the
            organisation. Store it the way you would store that.
          </Alert>
          <p className="rounded-md border border-border bg-muted/40 px-3 py-3 text-center font-mono text-lg tracking-wider">
            {password}
          </p>
          <Button
            variant="outline"
            className="w-full"
            onClick={async () => {
              // The password is shown once. "Copied" has to mean copied.
              if (await copyText(password, "Password copied")) setCopied(true);
            }}
          >
            <Copy className="size-4" aria-hidden />
            Copy password
          </Button>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onDone} disabled={!copied}>
            <Check className="size-4" aria-hidden />
            {copied ? "I have saved it" : "Copy it first"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks for the password, then saves the file the browser hands back.
 *
 * The response is a binary body rather than JSON, so this does its own fetch:
 * the shared client helper parses everything as JSON.
 */
function DownloadDialog({ job, onClose }: { job: ExportJobView; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/export/${job.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "download", password }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "That did not work. Try again.");
        return;
      }

      const blob = await response.blob();
      const name =
        /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ??
        "export.zip";

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);

      toast.success("Export downloaded.");
      onClose();
    } catch {
      setError("We could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock this export</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Enter the password shown when this export was built. What downloads is a plain ZIP —
            treat it accordingly.
          </p>
          <Field label="Password" htmlFor="export-password" error={error ?? undefined}>
            <Input
              id="export-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
              className="font-mono"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={password.trim().length === 0} onClick={download}>
            <Download className="size-4" aria-hidden />
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}