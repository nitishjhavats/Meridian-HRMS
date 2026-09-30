import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The page an installed app shows when it cannot reach the server.
 *
 * Launched from the home screen with no data, or tapped a manifest shortcut
 * while the container was restarting, and this page came up with no way off
 * it. In a browser tab F5 exists. In an installed window there is no address
 * bar: Android recovers only through an undocumented pull-to-refresh, and iOS
 * has no gesture at all, so the app had to be force-quit. Connectivity coming
 * back changed nothing on screen.
 *
 * It also said "You are offline" to somebody whose phone was online and whose
 * server was not, and promised that pages already opened would stay available,
 * which the worker has never done -- it caches the shell and this page. Every
 * earlier page lands here too.
 */

const PAGE = "src/app/offline/page.tsx";
const WORKER = "scripts/sw-source.js";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("there is a way off the page", () => {
  it("a Try again control that reloads the URL the worker answered for", () => {
    const body = code(PAGE);
    expect(body).toMatch(/id="offline-retry"/);
    expect(body).toMatch(/getElementById\("offline-retry"\)/);
    expect(body).toMatch(/addEventListener\("click",function\(\)\{location\.reload\(\)\}\)/);
  });

  it("and it reloads on its own the moment the device is back online", () => {
    const body = code(PAGE);
    expect(body).toMatch(/addEventListener\("online",function\(\)\{location\.reload\(\)\}\)/);
  });

  it("wired by a script inside the cached HTML, because the route chunk is not cached", () => {
    const body = code(PAGE);
    // A "use client" handler would render and never hydrate, exactly when it
    // was needed: only the HTML is precached, the chunk is fetched on demand,
    // and the demand is a page served because the network is down.
    expect(body).not.toMatch(/"use client"/);
    expect(body).toMatch(/<script dangerouslySetInnerHTML=/);
  });
});

describe("it says what it knows", () => {
  it("does not claim the device is offline when it may be the server that is out of reach", () => {
    const body = code(PAGE);
    expect(body).toMatch(/Could not reach HRMS/);
    expect(body).toMatch(/id="offline-no-network"/);
    expect(body).toMatch(/id="offline-no-server"/);
    expect(body).toMatch(/navigator\.onLine/);
  });

  it("and no longer promises pages that the worker never cached", () => {
    const body = code(PAGE);
    expect(body).not.toMatch(/already opened/);
    expect(body).not.toMatch(/stay available/);
  });
});

describe("the worker serves it only when the network itself failed", () => {
  function navigateBranch(): string {
    const worker = code(WORKER);
    const match = worker.match(/if \(request\.mode === "navigate"\) \{([\s\S]*?)\n    return;\n  \}/);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  it("from the catch of the network attempt, never from looking at a response", () => {
    const branch = navigateBranch();
    expect(branch).toMatch(/try \{[\s\S]*await fetch\(request\)[\s\S]*\} catch \{[\s\S]*cache\.match\(OFFLINE_URL\)/);
    // A 5xx is a response. It passes through to Next's own error page, which
    // knows what went wrong; this page does not.
    expect(branch).not.toMatch(/\.ok\b/);
    expect(branch).not.toMatch(/\.status\b/);
  });

  it("and has the page to serve, because install precached it", () => {
    const worker = code(WORKER);
    expect(worker).toMatch(/const OFFLINE_URL = "\/offline"/);
    expect(worker).toMatch(/const SHELL_ASSETS = \[\s*OFFLINE_URL,/);
  });
});
