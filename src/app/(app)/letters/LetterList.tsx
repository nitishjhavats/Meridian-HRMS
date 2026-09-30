"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Ban, Download, FileSignature, Pencil, Send, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { api, mutate } from "@/lib/client/api";
import { formatDate } from "@/lib/utils";

export interface LetterItem {
  id: string;
  letterNumber: string;
  category: string;
  categoryLabel: string;
  subject: string;
  status: "DRAFT" | "ISSUED" | "REVOKED";
  issuedOn: string | null;
  aiGenerated: boolean;
  hasPdf: boolean;
  pdfUrl: string | null;
  employee: { id: string; name: string; code: string };
  createdAt: string;
}

const TONE = {
  DRAFT: "neutral",
  ISSUED: "success",
  REVOKED: "danger",
} as const;

export function LetterList({
  letters,
  canManage,
  showOwner,
}: {
  letters: LetterItem[];
  canManage: boolean;
  showOwner: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, body: Record<string, unknown>, success: string) {
    setBusy(id);
    const ok = await mutate(() => api(`/api/letters/${id}`, { method: "POST", body }), {
      success,
      error: "That did not work",
    });
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  async function remove(id: string) {
    setBusy(id);
    const ok = await mutate(() => api(`/api/letters/${id}`, { method: "DELETE" }), {
      success: "Draft deleted.",
      error: "That draft was not deleted",
    });
    setBusy(null);
    if (ok !== null) router.refresh();
  }

  const actions = (l: LetterItem) => (
    <div className="flex flex-wrap gap-1.5">
      {l.pdfUrl ? (
        <a
          href={l.pdfUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          <Download className="size-3.5" aria-hidden />
          PDF
        </a>
      ) : null}

      {canManage && l.status === "DRAFT" ? (
        <>
          {/* Back into the editor on this same page. A draft the server would
              not issue -- a notice period nobody typed -- had nothing beside
              it here but Issue, which would refuse again, and the bin. */}
          <Button asChild size="sm" variant="ghost">
            <Link href={`/letters?draft=${l.id}`}>
              <Pencil className="size-4" aria-hidden />
              Edit
            </Link>
          </Button>
          <Button
            size="sm"
            variant="success"
            loading={busy === l.id}
            onClick={() => act(l.id, { action: "issue" }, `Issued as ${l.letterNumber}.`)}
          >
            <Send className="size-4" aria-hidden />
            Issue
          </Button>
          <Button size="sm" variant="ghost" className="text-danger-text" onClick={() => remove(l.id)}>
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </>
      ) : null}

      {canManage && l.status === "ISSUED" ? (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger-text"
          loading={busy === l.id}
          onClick={() => act(l.id, { action: "revoke" }, "Letter revoked.")}
        >
          <Ban className="size-4" aria-hidden />
          Revoke
        </Button>
      ) : null}
    </div>
  );

  return (
    <ResponsiveList
      items={letters}
      empty={
        <EmptyState
          icon={FileSignature}
          title={canManage ? "No letters yet" : "No letters issued to you"}
          description={
            canManage
              ? "Draft one by hand or ask the AI to write it for you."
              : "Letters your organisation issues to you will appear here."
          }
        />
      }
      head={
        <>
          <TH>Number</TH>
          {showOwner ? <TH>For</TH> : null}
          <TH>Type</TH>
          <TH>Issued</TH>
          <TH>Status</TH>
          <TH />
        </>
      }
      row={(l) => (
        <TR key={l.id}>
          <TD>
            <span className="tabular font-medium">{l.letterNumber}</span>
            <span className="block text-xs text-muted-foreground">{l.subject}</span>
          </TD>
          {showOwner ? (
            <TD>
              {l.employee.name}
              <span className="block text-xs text-muted-foreground">{l.employee.code}</span>
            </TD>
          ) : null}
          <TD>
            <span className="flex items-center gap-1">
              {l.categoryLabel}
              {l.aiGenerated ? (
                <Sparkles className="size-3 text-muted-foreground" role="img" aria-label="AI drafted" />
              ) : null}
            </span>
          </TD>
          <TD>{l.issuedOn ? formatDate(l.issuedOn) : "—"}</TD>
          <TD>
            <Badge tone={TONE[l.status]}>{l.status.toLowerCase()}</Badge>
          </TD>
          <TD>{actions(l)}</TD>
        </TR>
      )}
      card={(l) => (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="tabular text-sm font-medium">{l.letterNumber}</p>
              <p className="text-xs text-muted-foreground">{l.subject}</p>
              {showOwner ? (
                <p className="text-xs text-muted-foreground">
                  {l.employee.name} ({l.employee.code})
                </p>
              ) : null}
              {l.issuedOn ? (
                <p className="text-xs text-muted-foreground">Issued {formatDate(l.issuedOn)}</p>
              ) : null}
            </div>
            <Badge tone={TONE[l.status]}>{l.status.toLowerCase()}</Badge>
          </div>
          {actions(l)}
        </div>
      )}
    />
  );
}
