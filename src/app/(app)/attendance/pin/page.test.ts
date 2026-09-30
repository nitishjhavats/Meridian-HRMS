import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A receptionist named on the PIN authority screen holds
 * `attendance.pin.issue` and nothing wider. The desk's back link went to
 * /attendance, which refuses them, so the one link on their one screen was
 * a dead end. It now goes to the attendance screen they can open.
 */

const PAGE = "src/app/(app)/attendance/pin/page.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The `back` choice and the team check it rests on, up to the JSX. */
function backLink(): string {
  const body = code(PAGE);
  const start = body.indexOf("const seesTeam =");
  expect(start, "no back link choice").toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("return (", start));
}

describe("the PIN desk's back link", () => {
  it("goes to the team grid only for somebody the grid admits", () => {
    const block = backLink();
    expect(block).toMatch(/attendance\.read\.all/);
    expect(block).toMatch(/attendance\.read\.team/);
    expect(block).toMatch(/href: "\/attendance", label: "Attendance"/);
  });

  it("and to their own attendance otherwise", () => {
    const block = backLink();
    expect(block).toMatch(/attendance\.read\.self/);
    expect(block).toMatch(/href: "\/me\/attendance", label: "My attendance"/);
  });

  it("with the dashboard as the floor, which everybody can open", () => {
    expect(backLink()).toMatch(/href: "\/dashboard"/);
  });

  it("is what the link renders", () => {
    const body = code(PAGE);
    expect(body).toMatch(/href=\{back\.href\}/);
    expect(body).toMatch(/\{back\.label\}/);
    expect(body).not.toMatch(/href="\/attendance"/);
  });
});
