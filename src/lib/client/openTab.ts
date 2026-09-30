"use client";

/**
 * Open a URL that is only known after a request -- in a way Safari allows.
 *
 * `window.open(url)` after an `await` is outside the tap that caused it, and
 * iOS Safari (and Chrome, once the request takes long enough) refuses it with
 * no error: the button showed "Preparing..." and nothing opened. So the tab is
 * opened *inside* the tap, blank, and pointed at the file once it exists; if
 * even that is blocked, the current tab goes there instead. On failure the
 * blank tab is closed rather than left behind.
 */
export async function openTabAfter(resolve: () => Promise<string>): Promise<void> {
  const tab = typeof window !== "undefined" ? window.open("about:blank", "_blank") : null;
  try {
    const url = await resolve();
    if (tab && !tab.closed) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.location.assign(url);
    }
  } catch (error) {
    tab?.close();
    throw error;
  }
}
