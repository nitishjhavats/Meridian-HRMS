"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Alert } from "@/components/ui/states";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, mutate } from "@/lib/client/api";
import { copyText } from "@/lib/client/clipboard";

/**
 * Releasing a reset code.
 *
 * The code is shown once, here, to the platform owner — who then passes it on
 * out of band, having satisfied themselves the request is genuine. The app never
 * sends it to the person who asked.
 */
export function ResetActions({
  request,
}: {
  request: {
    id: string;
    userName: string;
    userEmail: string;
    status: string;
    expired: boolean;
    /** Null only for a superadmin, who has no organisation door. */
    resetUrl: string | null;
  };
}) {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const actionable = !request.expired && ["PENDING", "RELEASED"].includes(request.status);

  async function release() {
    setBusy(true);
    const result = await mutate(() =>
      api<{ code: string }>(`/api/platform/password-resets/${request.id}/release`, {
        method: "POST",
      }),
    );
    setBusy(false);
    if (result) {
      setCode(result.code);
      router.refresh();
    }
  }

  async function reject() {
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/platform/password-resets/${request.id}/reject`, {
          method: "POST",
          body: { reason: reason.trim() },
        }),
      { success: "Request rejected." },
    );
    setBusy(false);
    if (result) {
      setRejecting(false);
      setReason("");
      router.refresh();
    }
  }

  if (!actionable) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" loading={busy} onClick={release}>
        <KeyRound className="size-4" aria-hidden />
        {request.status === "RELEASED" ? "Show again" : "Release OTP"}
      </Button>
      <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
        <X className="size-4" aria-hidden />
        <span className="hidden sm:inline">Reject</span>
      </Button>

      <Dialog open={code !== null} onOpenChange={(open) => !open && setCode(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Verification code</DialogTitle>
            <DialogDescription>
              For {request.userName} ({request.userEmail})
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Alert tone="warning" title="Check who you are giving this to">
              <span className="flex gap-1.5">
                <ShieldAlert className="size-4 shrink-0" aria-hidden />
                Anyone with this code can set a new password on that account. Confirm the request
                is genuine before you share it, and share it directly — not over a public channel.
              </span>
            </Alert>

            <div className="mt-4 rounded-lg border border-border bg-muted p-6 text-center">
              <p className="tabular font-mono text-3xl font-semibold tracking-[0.3em]">{code}</p>
            </div>

            {/* A code with nowhere to type it is half an instruction, and the
                person reading it out is usually the only one who knows this
                page exists. */}
            {request.resetUrl ? (
              <div className="mt-3 rounded-md border border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">They type it at</p>
                <p className="break-all font-mono text-xs">{request.resetUrl}</p>
              </div>
            ) : null}

            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => {
                if (!code) return;
                void copyText(
                  request.resetUrl
                    ? `Code: ${code}
Set a new password at: ${request.resetUrl}

It works once and expires shortly.`
                    : code,
                  "Code copied",
                );
              }}
            >
              <Copy className="size-4" aria-hidden />
              {request.resetUrl ? "Copy code and link" : "Copy code"}
            </Button>

            <p className="mt-3 text-xs text-muted-foreground">
              Single use, and it expires with the request. Every time it is shown, an audit entry
              is written against your account.
            </p>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={rejecting} onOpenChange={setRejecting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this reset request</DialogTitle>
            <DialogDescription>
              {request.userName} will not receive a code. The request is closed.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Reason" htmlFor="reason" required>
              <Textarea
                id="reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Could not verify the request came from this person"
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} disabled={!reason.trim()} onClick={reject}>
              Reject request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
