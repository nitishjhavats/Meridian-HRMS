import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BLOWN_MEAN, DARK_MEAN, FRAME_HINTS, frameHintFor, meanLuma } from "./frameHint";

/**
 * The user asked whether the face-capture hints they had been shown actually
 * work on the reception screen. They did not: the sampling loop, the light
 * advice and the retry-or-PIN fork were all written into the phone's check-in
 * panel and none of it reached the kiosk, whose only live guidance was a
 * hardcoded "Blink now".
 */

describe("meanLuma", () => {
  it("is zero for an empty buffer rather than NaN", () => {
    // `sum / 0` is NaN, and NaN < 45 is false — so a camera that produced no
    // pixels would silently report the light as fine.
    expect(meanLuma(new Uint8ClampedArray(0))).toBe(0);
  });

  it("reads black as 0 and white as 255", () => {
    const black = new Uint8ClampedArray(4 * 16).fill(0);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    expect(meanLuma(black)).toBeCloseTo(0, 5);

    const white = new Uint8ClampedArray(4 * 16).fill(255);
    expect(meanLuma(white)).toBeCloseTo(255, 5);
  });

  it("weights green most, as Rec. 601 says", () => {
    const only = (r: number, g: number, b: number) =>
      meanLuma(new Uint8ClampedArray([r, g, b, 255]));
    expect(only(0, 255, 0)).toBeGreaterThan(only(255, 0, 0));
    expect(only(255, 0, 0)).toBeGreaterThan(only(0, 0, 255));
  });

  it("ignores a trailing partial pixel instead of averaging it in", () => {
    const ragged = new Uint8ClampedArray([255, 255, 255, 255, 12, 34]);
    expect(meanLuma(ragged)).toBeCloseTo(255, 5);
  });
});

describe("frameHintFor", () => {
  it("says nothing when the light is fine", () => {
    expect(frameHintFor(128)).toBeNull();
  });

  it("names the dark room and the window", () => {
    expect(frameHintFor(DARK_MEAN - 1)).toBe(FRAME_HINTS.DARK);
    expect(frameHintFor(BLOWN_MEAN + 1)).toBe(FRAME_HINTS.BACKLIT);
  });

  it("treats the thresholds themselves as acceptable", () => {
    expect(frameHintFor(DARK_MEAN)).toBeNull();
    expect(frameHintFor(BLOWN_MEAN)).toBeNull();
  });

  it("says nothing for a reading that is not a number", () => {
    expect(frameHintFor(Number.NaN)).toBeNull();
  });
});

/**
 * Source guards. The whole point of this round's audit is that a feature
 * existing is not the same as a feature being reachable, and this one existed
 * on one screen out of two for months.
 */
describe("both camera screens use it", () => {
  const read = (p: string) => readFileSync(path.resolve(p), "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("the kiosk samples the light", () => {
    expect(strip(read("src/app/kiosk/KioskScreen.tsx"))).toMatch(/useFrameHint\(/);
  });

  it("the phone samples the light", () => {
    expect(strip(read("src/app/(app)/me/attendance/CheckInPanel.tsx"))).toMatch(/useFrameHint\(/);
  });

  it("neither screen keeps a private copy of the arithmetic", () => {
    for (const file of [
      "src/app/kiosk/KioskScreen.tsx",
      "src/app/(app)/me/attendance/CheckInPanel.tsx",
    ]) {
      // The Rec. 601 coefficients, which used to be inline in the panel.
      expect(strip(read(file))).not.toMatch(/0\.587/);
    }
  });

  it("the kiosk refusal carries the reason, so it can offer the PIN", () => {
    const code = strip(read("src/services/attendance/kiosk.ts"));
    expect(code).toMatch(/face: verdict\.reason \?\? "NO_MATCH"/);
  });

  it("and carries how many tries are left before it can be marked anyway", () => {
    // Without this the device can only say "no" again. The number is the
    // server's, per reason: four for a face that will not match, none at all
    // for an organisation that has chosen a closed door.
    const code = strip(read("src/services/attendance/kiosk.ts"));
    expect(code).toMatch(/reviewAfterAttempts: verdict\.reviewAfterAttempts/);
  });

  it("the kiosk turns that reason into a choice rather than an alert", () => {
    const code = strip(read("src/app/kiosk/KioskScreen.tsx"));
    expect(code).toMatch(/details\?\.face/);
    expect(code).toMatch(/Check with PIN/);
    expect(code).toMatch(/Try again/);
  });
});
