"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, LogOut, ShieldAlert } from "lucide-react";

/**
 * The strip that says this is not really them.
 *
 * Permanent, undismissable and at the very top, because the alternative is a
 * platform owner forgetting which account they are in and making a change in
 * somebody's live payroll believing it is a test organisation. It says who is
 * being acted as, who is doing it, and offers the way out.
 */
export function ImpersonationBanner({
  actingAs,
  byEmail,
  organizationName,
  readOnly,
  expiresAt,
}: {
  actingAs: string;
  byEmail: string;
  organizationName: string | null;
  readOnly: boolean;
  /** ISO. A visit is thirty minutes; this is when it ends. */
  expiresAt: string;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [left, setLeft] = useState(() => minutesLeft(expiresAt));
  const ending = useRef(false);

  /**
   * The visit ends on the clock, and the screen has to end with it.
   *
   * The cookie lapsed silently: the next tap rendered a page with a superadmin
   * context and no organisation, which threw into "Something went wrong" under
   * a banner still reading "Acting as X". So the banner counts down, and at
   * zero goes home the hard way -- a full navigation, so nothing of the visit
   * is left in the router cache.
   */
  useEffect(() => {
    const tick = () => {
      const m = minutesLeft(expiresAt);
      setLeft(m);
      if (m <= 0 && !ending.current) {
        // Ended on the server first, once: a browser clock a minute ahead of
        // the server would otherwise bounce between /platform and /dashboard
        // until the cookie really lapsed.
        ending.current = true;
        fetch("/api/platform/impersonation", { method: "DELETE" })
          .catch(() => undefined)
          .finally(() => {
            window.location.href = "/platform";
          });
      }
    };
    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  async function stop() {
    setLeaving(true);
    const response = await fetch("/api/platform/impersonation", { method: "DELETE" });
    const payload = (await response.json().catch(() => null)) as { redirectTo?: string } | null;
    router.push(payload?.redirectTo ?? "/platform");
    router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-danger px-4 py-2 text-center text-xs font-medium text-danger-foreground">
      {readOnly ? (
        <Eye className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
      )}
      <span>
        Acting as <span className="underline underline-offset-2">{actingAs}</span>
        {organizationName ? ` at ${organizationName}` : ""} as {byEmail}.{" "}
        {readOnly
          ? "Read-only — nothing you do can change their data."
          : "Everything you do is recorded against Broadmate Global."}{" "}
        <span className="tabular-nums opacity-80">
          {left <= 1 ? "Ends in under a minute." : `Ends in ${left} min.`}
        </span>
      </span>
      <button
        type="button"
        onClick={() => void stop()}
        disabled={leaving}
        className="inline-flex items-center gap-1 rounded px-2 py-0.5 underline underline-offset-2 hover:bg-white/15 disabled:opacity-60"
      >
        <LogOut className="size-3.5" aria-hidden />
        {leaving ? "Leaving…" : "Stop"}
      </button>
    </div>
  );
}

function minutesLeft(expiresAt: string): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}
