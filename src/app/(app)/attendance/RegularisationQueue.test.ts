import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A team lead's own correction request sat in their queue with Approve and
 * Decline on it, and `decideRegularisation` refused both with a toast. The
 * queue is scoped to who the viewer can see, and a team includes its lead, so
 * the row is legitimately there -- it is the buttons that were wrong.
 */

const QUEUE = "src/app/(app)/attendance/RegularisationQueue.tsx";

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
  const start = body.indexOf("const actions = (r: RegularisationItem)");
  expect(start, "no actions renderer").toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("Approve", start));
}

describe("the reviewer's own correction", () => {
  it("is told apart by the employee behind the login", () => {
    const body = code(QUEUE);
    expect(body).toMatch(/viewerEmployeeId\?: string \| null/);
    expect(body).toMatch(/useViewer\(/);
    expect(body).toMatch(/r\.employee\.id === self/);
  });

  it("says it is waiting on somebody else, before any button is offered", () => {
    const block = actions();
    expect(block).toMatch(/r\.employee\.id === self/);
    expect(block).toMatch(/waiting for someone else/);
    // The check sits above the reject form and the approve button, so a
    // half-open decline on somebody's own row cannot survive it either.
    expect(block.indexOf("r.employee.id === self")).toBeLessThan(block.indexOf("rejecting === r.id"));
  });

  it("a history list never asks who is looking", () => {
    // The page renders the decided rows with `canDecide={false}`; nothing on
    // them can be clicked, so the round trip would buy nothing.
    expect(code(QUEUE)).toMatch(/useViewer\(canDecide && viewerEmployeeId === undefined\)/);
  });

  it("a page that knows the viewer skips the round trip", () => {
    const body = code(QUEUE);
    expect(body).toMatch(/viewerEmployeeId !== undefined \? viewerEmployeeId/);
  });
});
