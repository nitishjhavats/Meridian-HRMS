"use client";

import { usePathname } from "next/navigation";

import { useCallback, useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Install prompt and service-worker lifecycle.
 *
 * Rules the product asked for, and the reasoning behind them:
 *   - Show an unobtrusive banner only when the app is genuinely installable.
 *   - Once installed, never show it again — detected via `display-mode:
 *     standalone`, the `appinstalled` event, and iOS's `navigator.standalone`.
 *   - A dismissal is remembered for two weeks, so declining once does not mean
 *     being nagged on the next visit.
 *   - iOS has no `beforeinstallprompt`, so Safari users get the manual
 *     "Share → Add to Home Screen" hint instead of a dead button.
 */

const DISMISS_KEY = "hrms.install.dismissedUntil";
const DISMISS_DAYS = 14;

/**
 * How often an open tab asks whether the service worker changed.
 *
 * Fifteen minutes is a compromise: often enough that a device left running in
 * an office picks up a deploy the same morning, rare enough that it is noise
 * against everything else the page does.
 */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: window-controls-overlay)").matches ||
    // iOS Safari
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function dismissedRecently(): boolean {
  try {
    const until = window.localStorage.getItem(DISMISS_KEY);
    return until != null && Number(until) > Date.now();
  } catch {
    // Private mode or blocked storage — treat as not dismissed.
    return false;
  }
}

function rememberDismissal(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 86_400_000));
  } catch {
    // Nothing to do; the banner will simply reappear next visit.
  }
}

export function InstallPrompt({ className }: { className?: string }) {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (isStandalone()) {
      setInstalled(true);
      return;
    }
    setDismissed(dismissedRecently());

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);

    // iOS never fires beforeinstallprompt, so offer the manual route instead.
    if (isIosSafari()) setShowIosHint(true);

    const media = window.matchMedia("(display-mode: standalone)");
    const onDisplayChange = (e: MediaQueryListEvent) => setInstalled(e.matches);
    media.addEventListener("change", onDisplayChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      media.removeEventListener("change", onDisplayChange);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "dismissed") rememberDismissal();
    setDeferred(null);
  }, [deferred]);

  const close = useCallback(() => {
    rememberDismissal();
    setDismissed(true);
    setShowIosHint(false);
  }, []);

  if (installed || dismissed) return null;
  if (!deferred && !showIosHint) return null;

  return (
    <div
      className={cn(
        "fixed inset-x-3 bottom-3 z-50 rounded-lg border border-border bg-card p-3 shadow-lg",
        "sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96",
        className,
      )}
      role="dialog"
      aria-label="Install this app"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary-muted p-2">
          <Download className="size-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Install HRMS</p>
          {showIosHint && !deferred ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              Tap <Share className="inline size-3 align-[-2px]" role="img" aria-label="Share" /> then{" "}
              <strong>Add to Home Screen</strong> for one-tap check-in.
            </p>
          ) : (
            // Nothing about "offline" here. The worker caches the shell and an
            // offline page, not the pages somebody visited -- see `/offline` --
            // so a banner that promised offline access was promising something
            // the first lost connection disproved.
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add it to your device for one-tap check-in from the home screen.
            </p>
          )}
          {deferred ? (
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" onClick={install}>
                Install
              </Button>
              <Button size="sm" variant="ghost" onClick={close}>
                Not now
              </Button>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={close}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          aria-label="Dismiss"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

/**
 * Registers the service worker and surfaces updates.
 *
 * An update is offered rather than applied silently: reloading underneath
 * someone who is mid-form is its own kind of bug. The kiosk is the documented
 * exception — see `useApplyUpdatesAutomatically` — because a screen left in an
 * office has nobody standing there to accept a banner.
 *
 * The browser only re-fetches `/sw.js` on navigation, so a tab left open for
 * days would never notice a deploy. `registration.update()` on a timer and on
 * the tab becoming visible closes that gap.
 */
export function ServiceWorkerManager() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV === "development") return;

    let cancelled = false;

    let timer: ReturnType<typeof setInterval> | undefined;
    let onVisible: (() => void) | undefined;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        if (cancelled) return;

        if (registration.waiting) setWaiting(registration.waiting);

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              setWaiting(installing);
            }
          });
        });

        // Ask the server whether the worker changed. Cheap — `/sw.js` is served
        // `no-store` and is a few kilobytes — and it is the only thing that
        // makes a long-lived tab, or a kiosk, ever see a deploy.
        const check = () => {
          registration.update().catch(() => undefined);
        };
        timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
        onVisible = () => {
          if (document.visibilityState === "visible") check();
        };
        document.addEventListener("visibilitychange", onVisible);
      })
      .catch((error) => {
        console.warn("[pwa] service worker registration failed", error);
      });

    /**
     * Reload only when a worker is being *replaced*.
     *
     * `controllerchange` also fires the first time a page is ever controlled:
     * the worker installs, activates, calls `clients.claim()`, and this page --
     * which had no controller -- gets one. That is not an update. Reloading on
     * it meant every first visit on every device reloaded itself a few seconds
     * after load, longer on a slow phone, while somebody was typing their
     * password or had just landed on the organisation chooser -- the typed
     * credentials went, the in-flight login went, and they signed in twice.
     *
     * Tracked as it changes rather than read once: after that first claim the
     * page *is* controlled, so a deploy accepted from the banner later in the
     * same visit still reloads.
     */
    let controlled = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    const onControllerChange = () => {
      const wasControlled = controlled;
      controlled = true;
      if (!wasControlled) return;
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  const pathname = usePathname();
  const onKiosk = pathname?.startsWith("/kiosk") ?? false;

  if (!waiting) return null;

  /**
   * Not on the office device.
   *
   * It is `fixed ... bottom-3` and roughly ninety pixels tall, and the kiosk
   * footer is about forty — so it lands squarely on "Powered by Broadmate
   * Global" and hides it, with no scrolling involved at all. A screenshot of a
   * kiosk with a waiting worker therefore shows the header, no footer, and a
   * dialog, which reads exactly like the layout bug it is not.
   *
   * It would also be a prompt nobody is there to click: the kiosk adopts a new
   * worker on its own, on an interval.
   */
  if (onKiosk) return null;

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 rounded-lg border border-border bg-card p-3 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-80">
      <p className="text-sm font-medium">A new version is ready</p>
      <p className="mt-0.5 text-xs text-muted-foreground">Reload to get the latest changes.</p>
      <div className="mt-2.5 flex gap-2">
        <Button size="sm" onClick={() => waiting.postMessage("SKIP_WAITING")}>
          Reload
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWaiting(null)}>
          Later
        </Button>
      </div>
    </div>
  );
}

/** Small banner shown while the browser reports no connection. */
export function OnlineStatus() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      className="sticky top-0 z-50 bg-warning px-3 py-1.5 text-center text-xs font-medium text-warning-foreground"
      role="status"
    >
      You are offline — showing the last loaded data.
    </div>
  );
}
