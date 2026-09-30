"use client";

import { useState } from "react";
import { History } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/client/api";
import { formatMoney } from "@/lib/utils";

/**
 * How a payment request got where it is.
 *
 * `getOrderDetail` was written, tested and reachable from nothing. The list
 * showed a status and a total; the events behind them — raised, code issued,
 * UTR entered, confirmed, expired — existed only in the database. That timeline
 * is the whole answer when a customer rings to ask why their payment has not
 * gone through, and answering it meant opening a SQL client.
 */

interface OrderEvent {
  id: string;
  /** What the row actually carries (`PaymentOrderEvent`): a transition, not a `type`. */
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  createdAt: string;
}

interface OrderDetail {
  orderNumber: string;
  status: string;
  payablePaise: number;
  userCount: number;
  expired: boolean;
  minutesRemaining: number | null;
  hasIssuedCode: boolean;
  organization: { name: string } | null;
  events: OrderEvent[];
}

function label(status: string | null | undefined): string {
  return (status ?? "").replaceAll("_", " ").toLowerCase() || "raised";
}

export function OrderTimeline({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [failed, setFailed] = useState(false);

  function load() {
    setOpen(true);
    setOrder(null);
    setFailed(false);
    void api<{ order: OrderDetail }>(`/api/platform/payments/${orderId}`)
      .then((r) => setOrder(r.order))
      .catch(() => setFailed(true));
  }

  return (
    <>
      <Button size="sm" variant="ghost" aria-label={`History of ${orderNumber}`} onClick={load}>
        <History className="size-4" aria-hidden />
      </Button>

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{orderNumber}</DialogTitle>
            <DialogDescription>
              {order
                ? `${order.organization?.name ?? "—"} · ${formatMoney(order.payablePaise)} · ${order.userCount} seat(s)`
                : "Loading…"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            {failed ? (
              <p className="text-sm text-muted-foreground">That could not be loaded.</p>
            ) : order === null ? (
              <p className="text-sm text-muted-foreground">Loading&hellip;</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={order.status === "CONFIRMED" ? "success" : "neutral"}>
                    {order.status.replaceAll("_", " ").toLowerCase()}
                  </Badge>
                  {order.expired ? <Badge tone="danger">expired</Badge> : null}
                  {order.hasIssuedCode ? <Badge tone="info">code issued</Badge> : null}
                  {order.minutesRemaining !== null && !order.expired ? (
                    <span className="text-xs text-muted-foreground">
                      {order.minutesRemaining} min left
                    </span>
                  ) : null}
                </div>

                {order.events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing has happened to it since it was raised.
                  </p>
                ) : (
                  <ol className="space-y-2 border-l border-border pl-4">
                    {order.events.map((event) => (
                      <li key={event.id} className="relative">
                        <span
                          className="absolute -left-[1.3125rem] top-1.5 size-2 rounded-full bg-primary"
                          aria-hidden
                        />
                        <p className="text-sm font-medium">
                          {/* Events carry from/to statuses, not a `type`; reading
                              one that did not exist crashed the whole page on the
                              first click of the History button. */}
                          {event.fromStatus && event.fromStatus !== event.toStatus
                            ? `${label(event.fromStatus)} → ${label(event.toStatus)}`
                            : label(event.toStatus)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(event.createdAt).toLocaleString("en-IN")}
                          {event.note ? ` · ${event.note}` : ""}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
