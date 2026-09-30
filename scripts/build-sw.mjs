/**
 * Stamps a build identity into the service worker.
 *
 * Reads `scripts/sw-source.js`, replaces `__BUILD_ID__`, writes `public/sw.js`.
 * Runs as npm's `prebuild`, so `npm run build` cannot forget it.
 *
 * A service worker only updates when its own bytes change. The previous
 * hardcoded `"v1"` never changed, which made every deploy invisible to an
 * installed client. Any value that differs per build fixes that; the identity is
 * taken from, in order of preference:
 *
 *   BUILD_ID        — set explicitly
 *   SOURCE_COMMIT   — what Coolify passes for the deployed commit
 *   GIT_SHA         — common alternative
 *   the git HEAD     — for a local build in a checkout
 *   the current time — last resort, still unique per build
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildId } from "./build-id.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const id = buildId(join(here, '..'));

// Cache names are interpolated into a template literal, so anything that could
// close it or start a substitution has to go.
if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) {
  throw new Error(`Refusing to stamp an unsafe build id: ${JSON.stringify(id)}`);
}

const source = readFileSync(join(here, "sw-source.js"), "utf8");
const placeholder = "__BUILD" + "_ID__";

// Exactly one, so a stray mention in a comment cannot swallow the real
// substitution and ship a worker whose version never changes.
const occurrences = source.split(placeholder).length - 1;
if (occurrences !== 1) {
  throw new Error(
    `scripts/sw-source.js must contain the placeholder exactly once, found ${occurrences}`,
  );
}

const output = source.replace(placeholder, id);
mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(join(root, "public", "sw.js"), output, "utf8");

console.log(`[build-sw] public/sw.js written, CACHE_VERSION="${id}"`);
