import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The fallback for a client component whose page did not say who is looking.
 * Three screens use it -- two queues and the module switches -- and each one
 * had been offering a control the server always refused, because nothing on
 * the client knew whose request a row was or which permission a switch needed.
 */

const HOOK = "src/lib/client/useViewer.ts";
const SESSION = "src/app/api/auth/session/route.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("useViewer", () => {
  it("asks the session route, which answers with the employee and the permissions", () => {
    expect(code(HOOK)).toMatch(/api<SessionPayload>\("\/api\/auth\/session"/);
    // The two fields it reads are the two the route sends.
    const route = code(SESSION);
    expect(route).toMatch(/employeeId: ctx\.employeeId/);
    expect(route).toMatch(/permissions: \[\.\.\.ctx\.permissions\]/);
  });

  it("does not ask at all when the page already said", () => {
    const body = code(HOOK);
    expect(body).toMatch(/useViewer\(enabled = true\)/);
    expect(body).toMatch(/if \(!enabled\) return;/);
  });

  it("shares one request between components mounting together, then forgets it", () => {
    const body = code(HOOK);
    expect(body).toMatch(/let inFlight: Promise<Viewer> \| null = null/);
    expect(body).toMatch(/if \(!inFlight\)/);
    expect(body).toMatch(/inFlight = null/);
  });

  it("stays unknown rather than throwing when it cannot ask", () => {
    // The caller's fallback stands; `api` has already sent a 401 to sign in.
    const body = code(HOOK);
    const then = body.indexOf("fetchViewer().then(");
    expect(then).toBeGreaterThan(-1);
    expect(body.slice(then, body.indexOf("return () =>", then))).toMatch(/\(\) => \{\s*\}/);
  });
});
