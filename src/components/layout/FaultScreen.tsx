"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";
import { isSignInPage, signInHref } from "@/lib/client/api";

/**
 * The safety net, shared by every error boundary.
 *
 * Expected refusals -- no permission, module off, record not found -- are
 * handled where they happen and render their own screen. Anything that reaches
 * here is a genuine fault, so this says so honestly instead of guessing at a
 * cause. Next replaces server-side error messages with a generic string in
 * production and keeps only the digest, which is why the digest is shown: it is
 * the one thing that ties what the user saw to a line in the server log.
 *
 * **Except one fault, which is not a fault at all.** A session that has died
 * throws `UnauthorizedError` from whichever page is tapped next, and it used to
 * land here -- with two buttons that threw the same thing again, in an installed
 * app with no address bar to reload from. So the first thing this screen does is
 * ask whether anybody is still signed in; if not, it goes to the login page and
 * the person never reads "something went wrong" about their own morning.
 *
 * Both buttons are full navigations, not router pushes: a soft navigation
 * would re-render only the page segment, which is the exact path that failed.
 */
export function FaultScreen({
  error,
  reset,
  home,
  homeLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Where "back" goes. A real href, followed with a full load. */
  home: string;
  homeLabel: string;
}) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    console.error("[app] unhandled error", error);
  }, [error]);

  useEffect(() => {
    let cancelled = false;
    // On a sign-in page a signed-out visitor is the normal state, and sending
    // them to the login page from a fault on the login page would loop.
    if (isSignInPage()) {
      setChecking(false);
      return;
    }
    (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        const payload = (await response.json().catch(() => null)) as { authenticated?: boolean } | null;
        if (!cancelled && payload && payload.authenticated === false) {
          window.location.assign(signInHref());
          return;
        }
      } catch {
        // Could not ask. Show the fault; the person can still try again.
      }
      if (!cancelled) setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        One moment&hellip;
      </div>
    );
  }

  return (
    <ErrorState
      title="Something went wrong"
      description="This page could not be loaded. The problem has been logged."
      correlationId={error.digest}
      action={
        <div className="flex gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Button variant="outline" onClick={reset}>
            Try again
          </Button>
          <Button asChild variant="secondary">
            <a href={home}>{homeLabel}</a>
          </Button>
        </div>
      }
    />
  );
}
