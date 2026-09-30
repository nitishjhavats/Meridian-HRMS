import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MIN_FRAMES } from "./blink";
import {
  BLINK_LEAD_MS,
  BURST_FRAMES,
  BURST_GAP_MS,
  blinkWindowMs,
  blinkWindowSeconds,
} from "./capture";

/**
 * "check out k liye face match nahi ho raha … blink k wajah se hai to usko fix
 * karo."
 *
 * It was the blink, and the database said so before anything was changed: of
 * eighteen marks on the live instance in one morning, **sixteen** were refused
 * `NO_BLINK`, and every one of those carried `faceMatchScore: null`. The
 * identity comparison never ran — the liveness gate sits above it and refused
 * first. Face matching itself had been scoring 0.58 to 0.87 the week before,
 * against a 0.363 threshold.
 *
 * The cause was ordering, not sampling. "Blink now" appeared at the third frame
 * of an eight-frame, 1.4-second capture — roughly 360 ms in — so the whole
 * recording was over before a person had finished reading the instruction.
 * Nobody was missing the blink; nobody had blinked yet.
 *
 * These pin the arithmetic and, more importantly, the *order*: a later edit that
 * puts the prompt back inside the loop would restore the bug while leaving every
 * number here correct.
 */

const FILES = {
  phone: "src/app/(app)/me/attendance/CheckInPanel.tsx",
  kiosk: "src/app/kiosk/KioskScreen.tsx",
} as const;

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

describe("the blink window", () => {
  it("gives a person time to read the instruction before recording starts", () => {
    // The number that was effectively zero. Reaction to a visual cue is a
    // quarter-second at best, and closer to a second when the words are new.
    expect(BLINK_LEAD_MS).toBeGreaterThanOrEqual(600);
  });

  it("is long enough to hold a blink somebody has to decide to make", () => {
    // The old capture was 1.4 s measured from the prompt landing 360 ms in, so
    // about a second of usable window. This has to be visibly more than that.
    expect(blinkWindowMs()).toBeGreaterThanOrEqual(2_500);
    expect(blinkWindowSeconds()).toBe(Math.ceil(blinkWindowMs() / 1_000));
  });

  it("keeps frames close enough together that a 300 ms blink cannot hide", () => {
    // The original reasoning, which was right about sampling and is still the
    // reason the gap did not simply grow to fill the longer window.
    expect(BURST_GAP_MS).toBeLessThanOrEqual(300);
  });

  it("sends more frames than the detector needs to see a blink at all", () => {
    // `MIN_FRAMES` usable readings are required, and a frame with no detectable
    // face is discarded before counting — so a burst equal to the minimum fails
    // the moment one frame is blurred.
    expect(BURST_FRAMES).toBeGreaterThan(MIN_FRAMES);
  });
});

describe("the client and the server agree about how many frames there are", () => {
  it("the server cap is not below what the camera sends", () => {
    // Both mark routes `.slice(0, MAX_SEQUENCE_FRAMES)` silently. A cap below
    // the burst does not error — it drops the tail of the sequence, which is
    // exactly where a blink prompted at the start ends up.
    const engine = source("src/lib/face/engine.ts");
    const match = engine.match(/export const MAX_SEQUENCE_FRAMES = (\d+);/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(BURST_FRAMES);
  });
});

describe("both camera screens ask first and record second", () => {
  // The whole defect in one line of control flow, so it is asserted on the
  // source rather than on the constants. Pinning `BLINK_LEAD_MS` proves
  // nothing if the wait happens after the frames are already taken.
  for (const [name, file] of Object.entries(FILES)) {
    it(`${name}: the lead-in is awaited before the burst loop`, () => {
      const code = source(file);
      const wait = code.indexOf("BLINK_LEAD_MS");
      const loop = code.indexOf("i < BURST_FRAMES");
      expect(wait, `${file} never waits`).toBeGreaterThan(-1);
      expect(loop, `${file} has no burst loop`).toBeGreaterThan(-1);
      expect(wait, `${file} records before it asks`).toBeLessThan(loop);
    });

    it(`${name}: takes the reviewed still before asking for a blink`, () => {
      // The stored photo is what an administrator looks at on the review
      // screen. Taking it during the blink window means half the queue is
      // people with their eyes shut.
      const code = source(file);
      const still = code.indexOf("frames.push(still)");
      expect(still, `${file} never takes a still`).toBeGreaterThan(-1);
      expect(still, `${file} takes it inside the blink window`).toBeLessThan(
        code.indexOf("BLINK_LEAD_MS", code.indexOf("captureBurst")),
      );
    });

    it(`${name}: carries no second copy of the burst constants`, () => {
      // They were declared locally in both files and drifted independently of
      // the server cap, which is how the tail could be dropped unnoticed.
      const code = source(file);
      expect(code).not.toMatch(/const BURST_FRAMES\s*=/);
      expect(code).not.toMatch(/const BURST_GAP_MS\s*=/);
      expect(code).toMatch(/from "@\/domain\/attendance\/capture"/);
    });
  }
});
