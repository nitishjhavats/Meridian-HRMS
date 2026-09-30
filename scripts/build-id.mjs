import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * One answer to "which build is this?", used by the service worker's cache
 * name, by the page, and by anything else that needs to tell two deploys apart.
 *
 * The order matters and every step of it was earned:
 *
 *   1. `BUILD_ID` / `SOURCE_COMMIT` / `GIT_SHA` — what a platform passes when it
 *      is asked to. Coolify is *not* passing it here (every variable on the
 *      application is runtime-only), which is how this was found.
 *   2. `git rev-parse HEAD` — works on a developer's machine and never inside
 *      the image, because `.dockerignore` excludes `.git` on purpose to keep
 *      the build context small.
 *   3. A hash of the source that actually ships. This is the one that always
 *      works, and it is better than what it replaced in a way worth stating:
 *      the same code produces the same id, so rebuilding an unchanged commit no
 *      longer invalidates every client's cache.
 *
 * What it replaced was `Date.now().toString(36)`, which is why the live worker
 * was called `mtt84b37` and why "is that tablet on the old build?" could not be
 * answered from the screen.
 */

/** Files whose content decides the build. Everything served comes from these. */
const HASHED = ["src", "prisma/schema.prisma", "package-lock.json", "next.config.mjs"];

/** Anything generated, downloaded, or otherwise not the source of the build. */
const SKIP = new Set(["node_modules", ".next", ".git", "dist", "models", "fonts"]);

function walk(target, files) {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return;
  }
  if (stat.isFile()) {
    files.push(target);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(target).sort()) {
    if (SKIP.has(entry)) continue;
    walk(path.join(target, entry), files);
  }
}

function sourceHash(root) {
  const files = [];
  for (const entry of HASHED) walk(path.resolve(root, entry), files);
  if (files.length === 0) return null;

  const hash = createHash("sha256");
  // Sorted and path-prefixed, so a rename changes the id and file order cannot.
  for (const file of files.sort()) {
    hash.update(path.relative(root, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function gitHead(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
      .slice(0, 12);
  } catch {
    return null;
  }
}

export function buildId(root = process.cwd()) {
  const fromEnv = process.env.BUILD_ID || process.env.SOURCE_COMMIT || process.env.GIT_SHA;
  if (fromEnv) return fromEnv.trim().slice(0, 12);

  const head = gitHead(root);
  if (head) return head;

  const hashed = sourceHash(root);
  if (hashed) return hashed;

  // Nothing left to go on. Still deterministic within one build, and still
  // safe for a cache name.
  return "unknown";
}
