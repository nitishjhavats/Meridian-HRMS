"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Eye, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { PaymentCodeRow } from "@/services/platform/payments";

/**
 * Read a code again, or take it back.
 *
 * Both kinds can be shown again -- the order-bound one through the same
 * endpoint the Payments row uses -- and every showing is audited. Only an
 * advance code that has not been used can be withdrawn; an order-bound code
 * dies with its order.
 */
export function PaymentCodeActions({ code }: { code: PaymentCodeRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const canShow = code.state === "LIVE" || code.state === "APPLIED";
  const canRevoke = code.kind === "ADVANCE" && canShow;

  async function reveal() {
    setBusy(true);
    const result =
      code.kind === "ORDER"
        ? await mutate(() =>
            api<{ code: string | null }>(`/api/platform/payments/${code.orderId}/action`, {
              method: "POST",
              body: { action: "reveal_code" },
            }),
          )
        : await mutate(() =>
            api<{ code: string }>(`/api/platform/payment-codes/${code.id}/action`, {
              method: "POST",
              body: { action: "reveal" },
            }),
          );
    setBusy(false);
    if (result?.code) setShown(result.code);
  }

  async function revoke() {
    setBusy(true);
    const result = await mutate(
      () =>
        api(`/api/platform/payment-codes/${code.id}/action`, {
          method: "POST",
          body: { action: "revoke" },
        }),
      { success: "Code withdrawn. It will no longer be accepted." },
    );
    setBusy(false);
    if (result) {
      setConfirmRevoke(false);
      router.refresh();
    }
  }

  if (!canShow) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="outline" loading={busy} onClick={reveal}>
        <Eye className="size-4" aria-hidden />
        Show code
      </Button>
      {canRevoke ? (
        <Button size="sm" variant="outline" onClick={() => setConfirmRevoke(true)}>
          <Undo2 className="size-4" aria-hidden />
          <span className="hidden sm:inline">Withdraw</span>
        </Button>
      ) : null}

      <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Payment code</DialogTitle>
            <DialogDescription>
              {code.organizationName
                ? `For ${code.organizationName}. Share it yourself — the app never sends it to them.`
                : "For any organisation. Share it yourself — the app never sends it out."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="rounded-lg border border-border bg-muted p-6 text-center">
              <p className="tabular font-mono text-3xl font-semibold tracking-[0.3em]">{shown}</p>
            </div>
            <Button
              variant="outline"
              className="mt-3 w-full"
              onClick={() => {
                if (shown) void copyText(shown, "Code copied");
              }}
            >
              <Copy className="size-4" aria-hidden />
              Copy code
            </Button>
            <p className="mt-3 text-xs text-muted-foreground">
              Every time this code is shown it is written to the audit log.
            </p>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Withdraw this code?</DialogTitle>
            <DialogDescription>
              It will no longer be accepted at checkout or at confirmation.
              {code.state === "APPLIED"
                ? " The order it was applied to keeps its price, but will need a reference to confirm."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRevoke(false)}>
              Keep it
            </Button>
            <Button variant="danger" loading={busy} onClick={revoke}>
              Withdraw
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
