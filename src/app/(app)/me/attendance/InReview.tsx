"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { api, mutate } from "@/lib/client/api";

/**
 * "Your attendance is recorded, but it is not confirmed yet."
 *
 * A failed face check on somebody's own phone deliberately does not block the
 * mark — bad light should not cost a day's pay. But the employee was only told
 * in a toast that scrolled away, so the state was invisible to the one person
 * who could do something about it. This is that state, on the screen they
 * already open, with the two ways out of it.
 */

interface FlaggedDay {
  eventId: string;
  date: string;
  occurredAt: string;
  reason: string | null;
  rejected: boolean;
  reviewNote: string | null;
}

/**
 * Spelled the way the engine spells it.
 *
 * `NO_FACE` never matched anything the engine emits -- the reason code is
 * `NO_FACE_DETECTED` -- so that case fell through to the generic sentence. The
 * two blink reasons were missing entirely and are about to be the commonest
 * ones a person sees.
 */
const REASON: Record<string, string> = {
  NO_MATCH: "your photo did not match your reference photo",
  NO_FACE_DETECTED: "no face could be found in your photo",
  MULTIPLE_FACES: "somebody else was as close to the camera as you",
  LOW_QUALITY: "your photo was too unclear to check",
  NOT_ENROLLED: "you have no reference photo enrolled yet",
  ENGINE_UNAVAILABLE: "face checking was not running at the time",
  NO_BLINK: "we did not see you blink while the camera was recording",
  BLINK_UNKNOWN: "we could not tell whether you blinked",
};

function day(value: string): string {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export function InReview({ initial }: { initial: FlaggedDay[] }) {
  const router = useRouter();
  const [days, setDays] = useState(initial);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  if (days.length === 0) return null;

  const waiting = days.filter((d) => !d.rejected);
  const rejected = days.filter((d) => d.rejected);

  async function verify(eventId: string) {
    setBusy(true);
    const done = await mutate(
      () => api("/api/attendance/verify-pin", { method: "POST", body: { eventId, code: code.trim() } }),
      { success: "Confirmed. Thank you.", error: "That did not work" },
    );
    setBusy(false);
    if (done) {
      setDays((all) => all.filter((d) => d.eventId !== eventId));
      setOpenFor(null);
      setCode("");
      router.refresh();
    }
  }

  return (
    <Section
      title={waiting.length > 0 ? "Waiting to be confirmed" : "Not accepted"}
      description="Your attendance is recorded. The photo check could not confirm it was you."
    >
      <div className="space-y-3 p-4">
        {waiting.length > 0 ? (
          <Alert tone="info" title="You do not need to do anything">
            {/* "Press the same button again" pointed at a button that is not
                there: after a check-in the only one is Check out, and the
                server refuses that for five minutes. The retake has its own
                button on the check-in card now, and this names it. */}
            Your manager or an administrator will look at the photo and confirm it. Two ways to
            clear it sooner: tap Retake photo on the check-in card &mdash; if it matches this
            time the mark is confirmed on the spot, and your time is not changed &mdash; or ask
            them for a six-digit code and enter it below, which lasts fifteen minutes and works
            once.
          </Alert>
        ) : null}

        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {days.map((entry) => (
            <li key={entry.eventId} className="space-y-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <ShieldQuestion className="size-4 shrink-0 text-warning-text" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{day(entry.date)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {entry.rejected
                      ? // Not accepted now means the mark was taken back, so
                        // this has to say what actually happened to the day
                        // rather than leave somebody to find out at month end.
                        `${entry.reviewNote ?? "This mark was not accepted."} It has been removed — you can mark it again.`
                      : `In review — ${REASON[entry.reason ?? ""] ?? "it could not be checked"}.`}
                  </span>
                </span>
                {!entry.rejected ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setOpenFor(openFor === entry.eventId ? null : entry.eventId);
                      setCode("");
                    }}
                  >
                    {openFor === entry.eventId ? "Cancel" : "Verify now"}
                  </Button>
                ) : null}
              </div>

              {openFor === entry.eventId ? (
                <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border p-3">
                  <Field label="Code from your manager" htmlFor={`pin-${entry.eventId}`}>
                    <Input
                      id={`pin-${entry.eventId}`}
                      className="tabular w-32 tracking-[0.3em]"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    />
                  </Field>
                  <Button
                    size="sm"
                    loading={busy}
                    disabled={busy || code.trim().length < 4}
                    onClick={() => void verify(entry.eventId)}
                  >
                    Confirm
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>

        {rejected.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            A mark that was not accepted stays on your record with the reason. Ask your manager to
            correct the day if you think it is wrong.
          </p>
        ) : null}
      </div>
    </Section>
  );
}
