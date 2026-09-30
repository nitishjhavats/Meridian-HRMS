/**
 * HRMS service worker — source template.
 *
 * The CACHE_VERSION placeholder below is replaced by `scripts/build-sw.mjs`,
 * which runs as npm's `prebuild` step and writes the result to `public/sw.js`.
 * That generated file is not committed.
 *
 * Why it is generated rather than hand-edited: a service worker only updates
 * when its own bytes change. This file used to carry a hardcoded `"v1"` that was
 * never bumped, so `updatefound` never fired, the "update available" banner in
 * `InstallPrompt.tsx` was unreachable, the `activate` sweep below never matched
 * anything, and no deploy could be relied on to reach an installed client.
 * Stamping the build in makes every deploy a real update.
 *
 * Deliberately conservative about what it caches. This app deals with salary,
 * attendance and identity, so:
 *
 *   - API responses are NEVER cached. A stale payslip or an attendance record
 *     served from cache would be worse than an error message.
 *   - Attendance check-in is never queued for background sync. A queued punch
 *     would let the device decide the timestamp, which breaks payroll integrity;
 *     the UI shows an offline state and re-enables the button on reconnect.
 *   - Only the static shell and build assets are cached, plus an offline page.
 */

const CACHE_VERSION = "__BUILD_ID__";
const SHELL_CACHE = `hrms-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `hrms-assets-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline";

const SHELL_ASSETS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll fails the whole install if one URL 404s; add individually so a
      // single missing asset cannot brick the worker.
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => undefined),
        ),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("hrms-") && name !== SHELL_CACHE && name !== ASSET_CACHE)
          .map((name) => caches.delete(name)),
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

/**
 * The page asks the waiting worker to take over.
 *
 * `SKIP_WAITING` is sent when somebody accepts the update banner. The kiosk
 * sends it on its own, because a screen left in an office has nobody to click.
 */
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    /\.(?:css|js|woff2?|png|jpg|jpeg|svg|webp|ico)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never serve API data from cache.
  if (isApiRequest(url)) return;

  // Navigations: network first, fall back to the offline page.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const preloaded = await event.preloadResponse;
          if (preloaded) return preloaded;
          return await fetch(request);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const offline = await cache.match(OFFLINE_URL);
          return (
            offline ??
            new Response("<h1>You are offline</h1>", {
              status: 503,
              headers: { "Content-Type": "text/html; charset=utf-8" },
            })
          );
        }
      })(),
    );
    return;
  }

  // Build assets are immutable and safe to serve stale while revalidating.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(ASSET_CACHE);
        const cached = await cache.match(request);

        const network = fetch(request)
          .then((response) => {
            // Keep the worker alive long enough to finish writing. Without
            // this, returning `cached` below can end the event before the put
            // lands, and the asset is re-fetched for ever.
            if (response.ok) event.waitUntil(cache.put(request, response.clone()));
            return response;
          })
          .catch(() => null);

        if (cached) return cached;

        /**
         * Nothing cached, and the network failed.
         *
         * `respondWith` throws on undefined, so something must be returned --
         * but a 504 with an empty body makes the browser treat a missing
         * stylesheet as *successfully* nothing, and the page renders unstyled.
         * Falling through to the network gives the browser a real error, which
         * it reports and can retry.
         *
         * The kiosk is the screen most likely to meet this: it reloads itself
         * after every deploy, at the exact moment the old asset cache has just
         * been swept, and an unstyled reception screen is not a subtle failure.
         */
        const response = await network;
        if (response) return response;
        return fetch(request);
      })(),
    );
  }
});

/**
 * Web push. The payload carries only a title, body and link — never salary
 * figures or personal data, because a notification payload can sit in an OS
 * notification tray on a shared or locked device.
 */
self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "HRMS", body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? "HRMS", {
      body: payload.body ?? "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: payload.tag ?? "hrms",
      data: { url: payload.url ?? "/" },
      requireInteraction: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if (client.url.includes(target) && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })(),
  );
});
