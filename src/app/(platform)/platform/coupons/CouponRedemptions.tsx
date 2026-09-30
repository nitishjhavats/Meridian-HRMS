"use client";

import { useState } from "react";
import { Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/client/api";
import { formatMoney } from "@/lib/utils";

/**
 * Who actually used a coupon.
 *
 * `getCouponRedemptions` was written and called by nothing: the list showed
 * "12" and nowhere in the product turned that into twelve organisations, which
 * is the only question a count leads to.
 */

interface Redemption {
  id: string;
  discountPaise: number;
  createdAt: string;
  organizationId: string;
  /** Resolved by the service; null once the organisation is gone. */
  organizationName: string | null;
  paymentOrderId: string | null;
}

export function CouponRedemptions({ couponId, code, count }: { couponId: string; code: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Redemption[] | null>(null);
  const [failed, setFailed] = useState(false);

  if (count === 0) return null;

  function load() {
    setOpen(true);
    setRows(null);
    setFailed(false);
    void api<{ redemptions: Redemption[] }>(`/api/platform/coupons/${couponId}/redemptions`)
      .then((r) => setRows(r.redemptions))
      .catch(() => setFailed(true));
  }

  return (
    <>
      <Button size="sm" variant="ghost" aria-label={`Who used ${code}`} onClick={load}>
        <Users className="size-4" aria-hidden />
      </Button>

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{code}</DialogTitle>
            <DialogDescription>
              {count} redemption{count === 1 ? "" : "s"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {failed ? (
              <p className="text-sm text-muted-foreground">That could not be loaded.</p>
            ) : rows === null ? (
              <p className="text-sm text-muted-foreground">Loading&hellip;</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nobody has used it yet.</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    {/* The name, not the id: the dialog exists to say which
                        organisations used it, and a cuid says nothing. The
                        id is kept as the fallback because the row outlives
                        the organisation. */}
                    <a
                      href={`/platform/organisations/${row.organizationId}`}
                      className="min-w-0 truncate text-sm hover:underline"
                      title={row.organizationId}
                    >
                      {row.organizationName ?? row.organizationId}
                    </a>
                    <span className="tabular shrink-0 text-sm text-success-text">
                      −{formatMoney(row.discountPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
