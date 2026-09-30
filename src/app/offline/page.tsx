import { WifiOff } from "lucide-react";
import { MakerCredit } from "@/components/brand/MakerCredit";

export const metadata = { title: "Could not reach HRMS" };

/**
 * Served by the service worker when a navigation could not reach the server.
 *
 * "Could not reach", not "you are offline". The worker hands this page out
 * whenever the network request itself fails -- no data, but also DNS or TLS
 * failing, captive Wi-Fi, or the app container restarting mid-deploy -- and in
 * the last three the phone is online. An HTTP error never lands here: a 5xx is
 * a response, the worker passes it through, and Next renders its own error.
 *
 * The retry and the auto-reload are an inline script, not a client component,
 * and that is deliberate. Only this page's HTML is precached; its route chunk
 * is fetched when the page is served, which is to say with the network down --
 * so a `"use client"` button would render and never hydrate, precisely when it
 * was needed. The script is inside the cached HTML and runs regardless.
 *
 * `location.reload()` re-requests the URL that was asked for, because the
 * worker answered that URL with this page rather than redirecting to it. A
 * reload that fails lands here again with `navigator.onLine` already true, so
 * the `online` listener cannot chain reloads.
 */
const RETRY_SCRIPT = `(function(){
var retry=document.getElementById("offline-retry");
if(retry)retry.addEventListener("click",function(){location.reload()});
function reflect(){var on=navigator.onLine!==false;
var a=document.getElementById("offline-no-network");var b=document.getElementById("offline-no-server");
if(a)a.hidden=on;if(b)b.hidden=!on}
reflect();
window.addEventListener("offline",reflect);
window.addEventListener("online",function(){location.reload()});
})();`;

export default function OfflinePage() {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-sm text-center">
        <div className="mx-auto w-fit rounded-full bg-muted p-4">
          <WifiOff className="size-7 text-muted-foreground" aria-hidden />
        </div>
        <h1 className="mt-4 text-lg font-semibold">Could not reach HRMS</h1>
        {/* One of these two shows; the script picks by `navigator.onLine`. The
            no-network line is the default because that is the usual reason. */}
        <p id="offline-no-network" className="mt-1.5 text-sm text-muted-foreground">
          Your device has no connection. This page will try again on its own the moment it is
          back.
        </p>
        <p id="offline-no-server" className="mt-1.5 text-sm text-muted-foreground" hidden>
          Your device is online, so the server is out of reach for a moment. Try again shortly.
        </p>
        {/* No promise of cached pages. The worker keeps the shell and this page,
            not the pages somebody visited, so every earlier page lands here too. */}
        <p className="mt-3 text-sm text-muted-foreground">
          HRMS needs a connection for attendance, payroll and anything that saves, and nothing is
          kept on this device to browse without one.
        </p>
        {/* A plain element styled like `Button`, not `Button` itself: that one is
            a client module, and this page must not depend on a chunk arriving. */}
        <button
          id="offline-retry"
          type="button"
          className="mt-5 inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:w-auto"
        >
          Try again
        </button>
        <p className="mt-4 text-xs text-muted-foreground">
          Attendance is never marked offline — the check-in button comes back as soon as you
          reconnect, so your timestamp stays accurate.
        </p>
        {/* No logo here on purpose: this page is precached and served with the
            network down, and the platform mark is fetched from an API route. */}
        <MakerCredit className="mt-6 justify-center" />
      </div>
      <script dangerouslySetInnerHTML={{ __html: RETRY_SCRIPT }} />
    </main>
  );
}
