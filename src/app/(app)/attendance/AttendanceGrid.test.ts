import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * CHECKED_IN on the grid: a letter of its own, never a verdict to choose.
 *
 * The status exists so a day in progress stops reading "½" from the moment
 * somebody arrives. It is not final -- a check-out or the nightly close
 * replaces it -- so it must draw as its own thing and must not be offered in
 * the override select, where picking it would freeze a day open.
 */

const GRID = "src/app/(app)/attendance/AttendanceGrid.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** A top-level `const NAME = ...` literal, from its declaration to `closer`. */
function literal(body: string, name: string, closer: "};" | "];"): string {
  const start = body.indexOf(`const ${name}`);
  expect(start, `no ${name}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf(closer, start) + closer.length);
}

describe("CHECKED_IN on the month grid", () => {
  const body = code(GRID);

  it("has its own cell, in the info tone", () => {
    const cell = literal(body, "CELL", "};");
    expect(cell).toMatch(/CHECKED_IN: \{ letter: "I", className: "bg-info\/15 text-info-text", label: "Checked in" \}/);
  });

  it("is not something an admin can change a day to", () => {
    const options = literal(body, "OVERRIDE_OPTIONS", "];");
    expect(options).toMatch(/"FULL_DAY"/);
    expect(options).not.toMatch(/CHECKED_IN/);
  });

  it("opens the dialog on a real verdict when the day is open or unmarked", () => {
    expect(body).toMatch(
      /day\.status === "NOT_MARKED" \|\| day\.status === "CHECKED_IN" \? "FULL_DAY" : day\.status/,
    );
  });

  it("appears in the legend", () => {
    expect(body).toMatch(/\["FULL_DAY", "CHECKED_IN", "HALF_DAY", "ABSENT", "PAID_LEAVE", "WEEK_OFF", "HOLIDAY"\] as const/);
  });
});

describe("what was measured for each end of the day", () => {
  const body = code(GRID);

  it("reads the two marks the service carries", () => {
    expect(body).toMatch(/checkIn: \{ distanceMeters: number \| null; accuracyMeters: number \| null \} \| null;/);
    expect(body).toMatch(/checkOut: \{ distanceMeters: number \| null; accuracyMeters: number \| null \} \| null;/);
  });

  it("prints distance and fix together, and nothing for a mark with neither", () => {
    expect(body).toMatch(/if \(!mark\) return "";/);
    expect(body).toMatch(/`\$\{mark\.distanceMeters\} m from the branch`/);
    expect(body).toMatch(/`fix ±\$\{mark\.accuracyMeters\} m`/);
    expect(body).toMatch(/`In: \$\{describeMark\(open\.day\.checkIn\)\}`/);
    expect(body).toMatch(/`Out: \$\{describeMark\(open\.day\.checkOut\)\}`/);
    expect(body).toMatch(/\{markLine \? <p className="text-xs text-muted-foreground">\{markLine\}<\/p> : null\}/);
  });
});
