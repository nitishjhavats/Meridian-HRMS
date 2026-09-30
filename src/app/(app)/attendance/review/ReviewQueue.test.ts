import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The accuracy gate is off by default, so the reviewer has to see the
 * accuracy instead. "Inside the geofence, 12 m away" from a ±40 m fix is not
 * the evidence it looks like, and the card is where that judgement is made.
 */

const QUEUE = "src/app/(app)/attendance/review/ReviewQueue.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the review card and the reading's accuracy", () => {
  const body = code(QUEUE);

  it("reads it from the flagged event", () => {
    expect(body).toMatch(/accuracyMeters: number \| null;/);
  });

  it("prints it beside the distance, and only when there was one", () => {
    expect(body).toMatch(/event\.accuracyMeters !== null \? ` \(fix ±\$\{event\.accuracyMeters\} m\)` : ""/);
  });
});
