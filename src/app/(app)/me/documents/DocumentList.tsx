"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Clock,
  FileText,
  History,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert, EmptyState } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";
import { formatDate, formatRelative } from "@/lib/utils";

/**
 * Documents, from either side.
 *
 * The same component serves the employee looking at their own file and HR
 * looking at everyone's — what changes is which buttons appear, and that is
 * decided by permissions passed down from the server, never inferred here.
 */

export interface DocumentItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  category: string;
  categoryLabel: string;
  title: string;
  status: "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "EXPIRED";
  expiresOn: string | null;
  expired: boolean;
  expiringSoon: boolean;
  currentVersion: number;
  versions: {
    version: number;
    fileName: string;
    sizeBytes: number;
    mimeType: string;
    url: string;
    uploadedAt: string;
  }[];
  note: string | null;
  deletionRequested: boolean;
}

export interface DocumentAbilities {
  canVerify: boolean;
  canRequestDeletion: boolean;
  canUpload: boolean;
  /** Show whose document it is — only useful on the org-wide vault. */
  showOwner: boolean;
}

const STATUS = {
  PENDING_VERIFICATION: { tone: "warning", label: "Awaiting check" },
  VERIFIED: { tone: "success", label: "Verified" },
  REJECTED: { tone: "danger", label: "Rejected" },
  EXPIRED: { tone: "neutral", label: "Expired" },
} as const;

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentList({
  documents,
  abilities,
}: {
  documents: DocumentItem[];
  abilities: DocumentAbilities;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [openVersions, setOpenVersions] = useState<string | null>(null);

  async function act(id: string, body: Record<string, unknown>, success: string) {
    setBusy(id);
    const ok = await mutate(() => api(`/api/documents/${id}`, { method: "POST", body }), {
      success,
      error: "That did not work",
    });
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  if (documents.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No documents yet"
        description={
          abilities.canUpload
            ? "Upload identity, address or education proofs and they will be listed here."
            : "Documents added to your file will appear here."
        }
      />
    );
  }

  return (
    <ul className="divide-y divide-border">
      {documents.map((doc) => {
        const status = STATUS[doc.status];
        const current = doc.versions[0];

        return (
          <li key={doc.id} className="px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {doc.title}
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {doc.deletionRequested ? <Badge tone="warning">Deletion requested</Badge> : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {doc.categoryLabel}
                  {abilities.showOwner ? ` · ${doc.employeeName} (${doc.employeeCode})` : ""}
                  {doc.currentVersion > 1 ? ` · version ${doc.currentVersion}` : ""}
                </p>

                {doc.expiresOn ? (
                  <p
                    className={`mt-0.5 flex items-center gap-1 text-xs ${
                      doc.expired
                        ? "text-danger-text"
                        : doc.expiringSoon
                          ? "text-warning-text"
                          : "text-muted-foreground"
                    }`}
                  >
                    {doc.expired || doc.expiringSoon ? (
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                    ) : (
                      <Clock className="size-3.5 shrink-0" aria-hidden />
                    )}
                    {doc.expired ? "Expired" : "Expires"} {formatDate(doc.expiresOn)}
                  </p>
                ) : null}

                {doc.note ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{doc.note}</p>
                ) : null}
              </div>

              {/* No `shrink-0`. It and `flex-wrap` cancel each other out: a container
                  that refuses to shrink never gets narrow enough for its
                  children to wrap, so four action buttons pushed this row --
                  and the whole page -- 50px past a 375px screen. */}
              <div className="flex flex-wrap items-center gap-1.5">
                {current ? (
                  <a
                    href={current.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
                  >
                    Open ({humanSize(current.sizeBytes)})
                  </a>
                ) : null}

                {doc.versions.length > 1 ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpenVersions(openVersions === doc.id ? null : doc.id)}
                  >
                    <History className="size-4" aria-hidden />
                    {doc.versions.length}
                  </Button>
                ) : null}

                {abilities.canVerify && doc.status === "PENDING_VERIFICATION" ? (
                  <>
                    <Button
                      size="sm"
                      variant="success"
                      loading={busy === doc.id}
                      onClick={() => act(doc.id, { action: "verify" }, "Document verified.")}
                    >
                      <Check className="size-4" aria-hidden />
                      Verify
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => act(doc.id, { action: "reject" }, "Document rejected.")}
                    >
                      <X className="size-4" aria-hidden />
                      Reject
                    </Button>
                  </>
                ) : null}

                {abilities.canRequestDeletion && !doc.deletionRequested ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger-text"
                    loading={busy === doc.id}
                    onClick={() =>
                      act(
                        doc.id,
                        { action: "request-deletion" },
                        "Deletion requested — HR will review it.",
                      )
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                    Ask to remove
                  </Button>
                ) : null}
              </div>
            </div>

            {openVersions === doc.id ? (
              <ol className="mt-2 space-y-1 border-t border-border pt-2">
                {doc.versions.map((v) => (
                  <li key={v.version} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-muted-foreground">
                      v{v.version} · {v.fileName} · {humanSize(v.sizeBytes)} ·{" "}
                      {formatRelative(v.uploadedAt)}
                    </span>
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Open
                    </a>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------------------ uploader

const CATEGORIES = [
  { value: "IDENTITY", label: "Identity proof" },
  { value: "ADDRESS", label: "Address proof" },
  { value: "EDUCATION", label: "Education" },
  { value: "EMPLOYMENT", label: "Previous employment" },
  { value: "BANK", label: "Bank details" },
  { value: "CONTRACT", label: "Contracts and letters" },
  { value: "MEDICAL", label: "Medical" },
  { value: "OTHER", label: "Other" },
];

export function DocumentUploader({
  employeeId,
  employees,
}: {
  employeeId: string | null;
  /** Present only when the uploader may file documents for other people. */
  employees?: { id: string; name: string; code: string }[];
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    employeeId: employeeId ?? employees?.[0]?.id ?? "",
    category: "IDENTITY",
    title: "",
    expiresOn: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function upload(event: React.FormEvent) {
    event.preventDefault();
    if (!file || !form.employeeId) return;

    setBusy(true);
    setResult(null);

    const body = new FormData();
    body.set("file", file);
    body.set("employeeId", form.employeeId);
    body.set("category", form.category);
    body.set("title", form.title.trim() || file.name);
    if (form.expiresOn) body.set("expiresOn", form.expiresOn);

    try {
      const response = await fetch("/api/documents", { method: "POST", body });
      const payload = await response.json();
      if (!response.ok) {
        setResult(payload?.error?.message ?? "That upload failed.");
        return;
      }
      // Worth showing: the saving is often dramatic and explains the wait.
      const saved = payload.originalBytes - payload.sizeBytes;
      setResult(
        saved > 1024
          ? `Uploaded — compressed from ${humanSize(payload.originalBytes)} to ${humanSize(payload.sizeBytes)}.`
          : "Uploaded.",
      );
      setFile(null);
      setForm((f) => ({ ...f, title: "", expiresOn: "" }));
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    } catch {
      setResult("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={upload} className="space-y-3 p-4">
      {employees ? (
        <Field label="Whose document" htmlFor="docEmployee" required>
          <Select
            id="docEmployee"
            value={form.employeeId}
            onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))}
          >
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.code})
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Field label="Category" htmlFor="docCategory" required>
        <Select
          id="docCategory"
          value={form.category}
          onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Title" htmlFor="docTitle" hint="Defaults to the file name.">
        <Input
          id="docTitle"
          value={form.title}
          placeholder="Aadhaar card"
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
        />
      </Field>

      <Field label="Expires on" htmlFor="docExpiry" hint="Optional — for passports, visas, licences.">
        <Input
          id="docExpiry"
          type="date"
          value={form.expiresOn}
          onChange={(e) => setForm((f) => ({ ...f, expiresOn: e.target.value }))}
        />
      </Field>

      <Field label="File" htmlFor="docFile" required hint="Images and PDFs, up to 10 MB.">
        <Input
          id="docFile"
          ref={fileInput}
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
      </Field>

      <Button type="submit" loading={busy} disabled={!file || !form.employeeId}>
        <Upload className="size-4" aria-hidden />
        Upload
      </Button>

      {result ? (
        <Alert tone={result.startsWith("Uploaded") ? "success" : "danger"}>{result}</Alert>
      ) : null}
    </form>
  );
}
