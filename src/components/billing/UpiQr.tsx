"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/utils";
import { copyText } from "@/lib/client/clipboard";

/**
 * UPI payment block: a scannable QR plus the raw details for anyone typing them
 * in by hand.
 *
 * The QR encodes the same `upi://pay` link the server built from the server-side
 * amount, so what a payer sees in their UPI app is exactly what was quoted — the
 * page never composes an amount of its own.
 */
export function UpiQr({
  upiLink,
  upiId,
  payeeName,
  amountPaise,
  orderNumber,
}: {
  upiLink: string;
  upiId: string;
  payeeName: string;
  amountPaise: number;
  orderNumber: string;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(upiLink, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 320,
      color: { dark: "#111827", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        // A missing QR must not hide the payment details underneath it.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [upiLink]);

  function copy(value: string, label: string) {
    void copyText(value, `${label} copied`);
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
      <div className="mx-auto w-fit rounded-lg border border-border bg-white p-3">
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={`UPI QR code for ${formatMoney(amountPaise)} to ${upiId}`}
            width={200}
            height={200}
            className="size-[200px]"
          />
        ) : (
          <div className="grid size-[200px] place-items-center text-center text-xs text-gray-500">
            {failed ? "QR unavailable — use the UPI ID below" : "Generating…"}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-xs text-muted-foreground">Amount to pay</p>
          <p className="tabular text-2xl font-semibold">{formatMoney(amountPaise)}</p>
        </div>

        <dl className="space-y-2 text-sm">
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">UPI ID</dt>
              <dd className="truncate font-mono">{upiId}</dd>
            </div>
            <Button size="sm" variant="ghost" onClick={() => copy(upiId, "UPI ID")}>
              <Copy className="size-4" aria-hidden />
              <span className="sr-only">Copy UPI ID</span>
            </Button>
          </div>
          <div className="rounded-md border border-border px-3 py-2">
            <dt className="text-xs text-muted-foreground">Payee</dt>
            <dd>{payeeName}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Reference to quote</dt>
              <dd className="truncate font-mono">{orderNumber}</dd>
            </div>
            <Button size="sm" variant="ghost" onClick={() => copy(orderNumber, "Reference")}>
              <Copy className="size-4" aria-hidden />
              <span className="sr-only">Copy reference</span>
            </Button>
          </div>
        </dl>

        {/* On a phone the QR is useless — the UPI app is on the same device. */}
        <Button asChild variant="outline" className="w-full sm:hidden">
          <a href={upiLink}>
            <Smartphone className="size-4" aria-hidden />
            Open in a UPI app
          </a>
        </Button>
      </div>
    </div>
  );
}
