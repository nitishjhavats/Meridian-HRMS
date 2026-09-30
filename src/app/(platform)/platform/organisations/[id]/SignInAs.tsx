"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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

/**
 * Signing in as one of a customer's people.
 *
 * The reason is required, and it is not a formality: it lands in that
 * organisation's own audit log, where their administrator can read it. Being
 * visited by the vendor is something a customer is entitled to see, and a
 * support session with no stated reason is indistinguishable from a look
 * through their salaries.
 */
/** What `POST /api/platform/impersonation` accepts, so the cap is visible while typing. */
const MAX_REASON = 200;

export function SignInAs({
  userId,
  name,
  email,
  role,
}: {
  userId: string;
  name: string;
  email: string;
  role: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  // A device account has no person behind it, and one platform owner does not
  // act as another. The service refuses both; not offering them is kinder.
  // A device can be acted as, read-only, so a support engineer can see the
  // reception screen instead of asking somebody to describe it down a phone.
  // Another platform owner still cannot.
  if (role === "SUPERADMIN") return null;

  async function start() {
    setBusy(true);
    const result = await mutate<{ redirectTo: string }>(
      () =>
        api("/api/platform/impersonation", {
          method: "POST",
          body: { userId, reason: reason.trim(), readOnly },
        }),
      { success: `Acting as ${name}.`, error: "That session did not start" },
    );
    setBusy(false);
    if (result) {
      setOpen(false);
      router.push(result.redirectTo);
      router.refresh();
    }
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <UserRoundCog className="size-4" aria-hidden />
        Sign in as
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in as {name}</DialogTitle>
            <DialogDescription>
              You will see and use the product exactly as {email} does, for thirty minutes.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="space-y-4">
            <Alert tone="warning" title="This is written to their audit log">
              Every change you make is recorded against Broadmate Global as well as against{" "}
              {name}, so their log never claims they did it.
            </Alert>

            <Field
              label="Why"
              htmlFor="impersonationReason"
              required
              hint={
                reason.trim().length > 0 && reason.trim().length < 4
                  ? "A few more characters. Their administrator can read this."
                  : `Their administrator can read this. ${MAX_REASON - reason.length} characters left.`
              }
            >
              <Input
                id="impersonationReason"
                value={reason}
                maxLength={MAX_REASON}
                autoCapitalize="sentences"
                autoComplete="off"
                enterKeyHint="done"
                placeholder="Investigating their payroll lock failing"
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>

            <div className="flex items-center gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Look, don&rsquo;t touch</p>
                <p className="text-xs text-muted-foreground">
                  Blocks every write while you are in. Use it when the visit is a question rather
                  than a fix.
                </p>
              </div>
              <Switch
                checked={readOnly}
                disabled={busy}
                aria-label="Read-only"
                onCheckedChange={setReadOnly}
              />
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={busy || reason.trim().length < 4}
              onClick={() => void start()}
            >
              Sign in as {name}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
