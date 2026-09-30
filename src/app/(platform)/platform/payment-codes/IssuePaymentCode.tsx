"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Copy, Plus, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
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
import { formatMoney } from "@/lib/utils";

/**
 * Making a code, either kind.
 *
 * "Payment received" is for a request already in the queue: pick it, and the
 * code approves it the moment the organisation types it in. "In advance" is
 * the deal made on the phone before anybody has pressed Buy: for one
 * organisation or for anybody, with or without a discount, good for a while.
 */

interface OpenOrder {
  id: string;
  orderNumber: string;
  organizationName: string;
  payablePaise: number;
  userCount: number;
}

type Kind = "order" | "advance";

export function IssuePaymentCode({
  organisations,
  openOrders,
}: {
  organisations: { id: string; name: string }[];
  openOrders: OpenOrder[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<Kind>(openOrders.length > 0 ? "order" : "advance");
  const [orderId, setOrderId] = useState(openOrders[0]?.id ?? "");
  const [issued, setIssued] = useState<{ code: string; expiresAt: string | null } | null>(null);

  const [form, setForm] = useState({
    organizationId: "",
    discountPercent: null as number | null,
    maxDiscountRupees: null as number | null,
    validDays: 30,
    note: "",
  });

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const chosenOrder = openOrders.find((o) => o.id === orderId) ?? null;
  // Rounded on the way to paise; `× 100` on a raw float is not an amount of money.
  const cap = form.maxDiscountRupees ? Math.round(form.maxDiscountRupees * 100) : null;

  async function submit() {
    setBusy(true);
    if (kind === "order") {
      const result = await mutate(
        () =>
          api<{ code: string }>(`/api/platform/payments/${orderId}/action`, {
            method: "POST",
            body: { action: "issue_code" },
          }),
        { success: "Code issued. It approves the request as soon as it is entered." },
      );
      setBusy(false);
      if (result) setIssued({ code: result.code, expiresAt: null });
      return;
    }

    const result = await mutate(
      () =>
        api<{ code: string; expiresAt: string }>("/api/platform/payment-codes", {
          method: "POST",
          body: {
            organizationId: form.organizationId || null,
            discountPercent: form.discountPercent && form.discountPercent > 0 ? form.discountPercent : null,
            maxDiscountPaise: cap,
            validDays: form.validDays,
            note: form.note.trim() || null,
          },
        }),
      { success: "Code created.", error: "Could not create the code" },
    );
    setBusy(false);
    if (result) setIssued({ code: result.code, expiresAt: result.expiresAt });
  }

  function close() {
    setOpen(false);
    if (issued) {
      setIssued(null);
      router.refresh();
    }
  }

  const valid =
    kind === "order"
      ? orderId.length > 0
      : form.validDays >= 1 &&
        form.validDays <= 365 &&
        (form.discountPercent == null || (form.discountPercent >= 0 && form.discountPercent <= 100));

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        Generate code
      </Button>

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-lg">
          {issued ? (
            <>
              <DialogHeader>
                <DialogTitle>Here is the code</DialogTitle>
                <DialogDescription>
                  Read it out or paste it to them yourself — the app never sends it.
                </DialogDescription>
              </DialogHeader>
              <DialogBody>
                <div className="rounded-lg border border-border bg-muted p-6 text-center">
                  <p className="tabular font-mono text-3xl font-semibold tracking-[0.3em]">
                    {issued.code}
                  </p>
                </div>
                <Button
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={() => void copyText(issued.code, "Code copied")}
                >
                  <Copy className="size-4" aria-hidden />
                  Copy code
                </Button>
                <p className="mt-3 text-xs text-muted-foreground">
                  {kind === "order"
                    ? "Works once, on this request only. The moment they enter it the request is approved in your name and their seats go live."
                    : `Works once, until ${issued.expiresAt ? new Date(issued.expiresAt).toLocaleDateString("en-IN") : "it expires"}. They can enter it while buying seats — the discount shows before they pay — or when confirming a payment. The request still comes to you for approval.`}
                </p>
              </DialogBody>
              <DialogFooter>
                <Button onClick={close}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Generate a payment code</DialogTitle>
                <DialogDescription>
                  Six digits the organisation types in. What it does depends on what it is for.
                </DialogDescription>
              </DialogHeader>

              <DialogBody className="space-y-4">
                <div className="flex gap-1 rounded-lg bg-muted p-1">
                  <button
                    type="button"
                    onClick={() => setKind("order")}
                    className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      kind === "order" ? "bg-card shadow-sm" : "text-muted-foreground"
                    }`}
                  >
                    <Receipt className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
                    Payment received
                  </button>
                  <button
                    type="button"
                    onClick={() => setKind("advance")}
                    className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                      kind === "advance" ? "bg-card shadow-sm" : "text-muted-foreground"
                    }`}
                  >
                    <CalendarClock className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
                    In advance
                  </button>
                </div>

                {kind === "order" ? (
                  <>
                    <Alert tone="info" title="Approves on entry">
                      For a request already raised, whose payment you have seen. The moment the
                      organisation enters this code the request is approved in your name.
                    </Alert>
                    {openOrders.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No open request is waiting for a code right now.
                      </p>
                    ) : (
                      <Field label="Request" htmlFor="orderId" required>
                        <Select
                          id="orderId"
                          value={orderId}
                          onChange={(e) => setOrderId(e.target.value)}
                        >
                          {openOrders.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.orderNumber} · {o.organizationName} · {formatMoney(o.payablePaise)}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    {chosenOrder ? (
                      <p className="text-xs text-muted-foreground">
                        {chosenOrder.userCount} seats · {formatMoney(chosenOrder.payablePaise)} to
                        be collected.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Alert tone="info" title="Goes to the queue">
                      For a deal made before the organisation has raised a request. They enter it
                      while buying seats or when confirming; the request still comes to you to
                      approve.
                    </Alert>

                    <Field
                      label="Organisation"
                      htmlFor="organizationId"
                      hint="Leave on 'Any' for a code anybody can use."
                    >
                      <Select
                        id="organizationId"
                        value={form.organizationId}
                        onChange={(e) => set("organizationId", e.target.value)}
                      >
                        <option value="">Any organisation</option>
                        {organisations.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name}
                          </option>
                        ))}
                      </Select>
                    </Field>

                    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                      <Field
                        label="Discount %"
                        htmlFor="discountPercent"
                        hint="Blank = no discount, the code only confirms."
                      >
                        <NumberField
                          id="discountPercent"
                          min={0}
                          max={100}
                          decimals={2}
                          value={form.discountPercent}
                          onValueChange={(v) => set("discountPercent", v)}
                          className="tabular"
                        />
                      </Field>
                      <Field
                        label="Cap the discount at (₹)"
                        htmlFor="maxDiscountRupees"
                        hint="Optional ceiling."
                      >
                        <NumberField
                          id="maxDiscountRupees"
                          min={1}
                          decimals={2}
                          value={form.maxDiscountRupees}
                          onValueChange={(v) => set("maxDiscountRupees", v)}
                          className="tabular"
                          disabled={!form.discountPercent}
                        />
                      </Field>
                    </div>

                    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                      <Field label="Valid for (days)" htmlFor="validDays" required>
                        <NumberField
                          id="validDays"
                          min={1}
                          max={365}
                          value={form.validDays}
                          onValueChange={(v) => set("validDays", v ?? 0)}
                          className="tabular"
                        />
                      </Field>
                      <Field label="Note" htmlFor="note" hint="Who it is for, so you remember.">
                        <Input
                          id="note"
                          value={form.note}
                          onChange={(e) => set("note", e.target.value)}
                          placeholder="Agreed with Rahul on the phone"
                          maxLength={200}
                        />
                      </Field>
                    </div>
                  </>
                )}
              </DialogBody>

              <DialogFooter>
                <Button variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button
                  loading={busy}
                  disabled={!valid || (kind === "order" && openOrders.length === 0)}
                  onClick={submit}
                >
                  Generate
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
