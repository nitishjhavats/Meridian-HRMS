import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * An approver's own leave sat under "Waiting for a decision" with Approve and
 * Reject on it, and `decideLeave` refused both with a toast. The list is
 * scoped to who the viewer can see and everybody can see themselves, so the
 * row belongs there -- the buttons did not.
 */

const QUEUE = "src/app/(app)/leave/ApprovalQueue.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The `actions` renderer, from its declaration to the approve button. */
function actions(): string {
  const body = code(QUEUE);
  const start = body.indexOf("const actions = (r: QueueRow)");
  expect(start, "no actions renderer").toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("Approve", start));
}

describe("the approver's own leave", () => {
  it("is told apart by the employee behind the login", () => {
    const body = code(QUEUE);
    expect(body).toMatch(/viewerEmployeeId\?: string \| null/);
    expect(body).toMatch(/useViewer\(viewerEmployeeId === undefined\)/);
    expect(body).toMatch(/r\.employee\.id === self/);
  });

  it("says it is waiting on somebody else, before any button is offered", () => {
    const block = actions();
    expect(block).toMatch(/waiting for someone else/);
    expect(block.indexOf("r.employee.id === self")).toBeLessThan(block.indexOf("rejecting === r.id"));
  });

  it("a page that knows the viewer skips the round trip", () => {
    expect(code(QUEUE)).toMatch(/viewerEmployeeId !== undefined \? viewerEmployeeId/);
  });
});
