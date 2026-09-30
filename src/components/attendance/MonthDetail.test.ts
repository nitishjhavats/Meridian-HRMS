import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The two personal calendars -- the employee's own and the reception
 * screen's -- read the same status letters. CHECKED_IN is new, and a status
 * these maps do not know draws as "·" (or "."), which on today's tile reads as
 * "not marked" to somebody who marked an hour ago.
 */

const FILES = {
  "MonthDetail (my attendance)": "src/components/attendance/MonthDetail.tsx",
  "KioskMonth (reception screen)": "src/app/kiosk/KioskMonth.tsx",
};

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function literal(body: string, name: string): string {
  const start = body.indexOf(`const ${name}`);
  expect(start, `no ${name}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("};", start) + 2);
}

describe.each(Object.entries(FILES))("%s", (_label, file) => {
  const body = code(file);

  it("draws a checked-in day as I", () => {
    expect(literal(body, "LETTER")).toMatch(/CHECKED_IN: "I",/);
  });

  it("colours it as in progress, not as a verdict", () => {
    expect(literal(body, "TONE")).toMatch(/CHECKED_IN: "bg-info-muted text-info-text",/);
  });

  it("explains the letter in the legend", () => {
    expect(body).toMatch(/I checked in/);
  });
});
