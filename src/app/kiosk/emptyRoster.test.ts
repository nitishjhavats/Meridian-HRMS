import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * An empty roster is not an empty search.
 *
 * Before anybody had typed, a brand-new organisation -- or a device narrowed
 * to a branch with nobody assigned -- read `Nobody matches “”.`, empty quotes
 * and all. The roster is checked before the search result, and the branch
 * case names the branch and who can fix it.
 */

const SCREEN = "src/app/kiosk/KioskScreen.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the kiosk with nobody on it", () => {
  const body = code(SCREEN);

  it("says the roster is empty before it says nobody matched", () => {
    const empty = body.indexOf("{roster.length === 0 ? (");
    const search = body.indexOf("filtered.length === 0 ? (");
    expect(empty).toBeGreaterThan(-1);
    expect(search).toBeGreaterThan(empty);
    // The empty-search line is reached only through the else of the roster check.
    expect(body).toMatch(/\) : filtered\.length === 0 \? \(/);
  });

  it("with a sentence for each kind of empty", () => {
    expect(body).toMatch(/"Nobody is on the roster — ask an administrator\."/);
    expect(body).toMatch(
      /`Nobody is assigned to \$\{device\.workLocation\.name\} — ask an administrator\.`/,
    );
  });

  it("does not introduce the branch and then say it is empty", () => {
    // "Showing people who work at Pune." directly above "Nobody is assigned
    // to Pune" named the branch twice to say one thing.
    expect(body).toMatch(/rosterScope === "WORK_LOCATION" && roster\.length > 0 \? \(/);
  });
});
