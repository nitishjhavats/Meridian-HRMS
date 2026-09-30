import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The first visit on a new phone reloaded itself.
 *
 * Open `/o/<slug>`, start typing, and a few seconds later -- longer on a slow
 * connection, because the worker was still precaching -- the page reloads under
 * you. Typed credentials gone; a login already in flight aborted; the
 * organisation chooser, which lives in component state, back to the form.
 * Exactly once per device, then never again, which is why it read like a
 * flaky network rather than a bug.
 *
 * The cause: the worker calls `clients.claim()` on activate, which fires
 * `controllerchange` on a page that never had a controller, and the page treated
 * every `controllerchange` as "a new version took over, reload". Only a
 * *replaced* controller is that.
 */

const COMPONENT = "src/components/pwa/InstallPrompt.tsx";

function code(): string {
  return readFileSync(path.resolve(COMPONENT), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("a page that had no controller does not reload when it gets one", () => {
  it("records whether the page was controlled before the change", () => {
    const body = code();
    expect(body).toMatch(/let controlled = Boolean\(navigator\.serviceWorker\.controller\)/);
  });

  it("and bails out of the reload when it was not", () => {
    const body = code();
    const handler = body.match(/const onControllerChange = \(\) => \{([\s\S]*?)\n\s*\};/);
    expect(handler).not.toBeNull();
    const inner = handler![1]!;
    // The previous state is read, then overwritten, then decides -- in that
    // order. Reading it after the overwrite would reload on the first claim
    // again; never overwriting would skip the reload a deploy asks for later.
    const read = inner.indexOf("const wasControlled = controlled");
    const mark = inner.indexOf("controlled = true");
    const bail = inner.indexOf("if (!wasControlled) return");
    const reload = inner.indexOf("window.location.reload()");
    expect(read).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(read);
    expect(bail).toBeGreaterThan(mark);
    expect(reload).toBeGreaterThan(bail);
  });

  it("the worker still claims on activate, so the guard is what stops the reload", () => {
    // Dropping `clients.claim()` would also fix it, and would take the offline
    // fallback away from the very first navigation. The guard is the fix.
    const worker = readFileSync(path.resolve("scripts/sw-source.js"), "utf8");
    expect(worker).toMatch(/self\.clients\.claim\(\)/);
  });
});

describe("the install banner does not promise offline pages", () => {
  it("because the worker caches the shell and an offline page, nothing else", () => {
    const body = code();
    expect(body).not.toMatch(/offline (?:viewing|access)/i);
  });
});
