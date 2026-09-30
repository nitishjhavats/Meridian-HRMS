import { describe, expect, it } from "vitest";
import { BLINK_DEPTH, MIN_FRAMES, STATIC_SPREAD, detectBlink, patchOpenness } from "./blink";

/** A steady open eye with the small jitter a live face always has. */
const LIVE_OPEN = [0.62, 0.6, 0.63, 0.61, 0.6, 0.62, 0.61, 0.6];

describe("detectBlink", () => {
  it("sees a blink that closes and reopens", () => {
    const verdict = detectBlink([0.62, 0.6, 0.58, 0.12, 0.05, 0.4, 0.61, 0.6]);
    expect(verdict.blinked).toBe(true);
    expect(verdict.reason).toBe("BLINKED");
    expect(verdict.depth).toBeGreaterThan(BLINK_DEPTH);
  });

  it("does not call an open eye a blink", () => {
    const verdict = detectBlink(LIVE_OPEN);
    expect(verdict.blinked).toBe(false);
    expect(verdict.reason).toBe("EYES_OPEN");
  });

  it("refuses a printed photograph, and says that is what it is", () => {
    // The signal that actually catches a print-out: a living face never holds
    // this still, so an identical series is a picture of a face.
    const verdict = detectBlink([0.55, 0.55, 0.55, 0.55, 0.55, 0.55]);
    expect(verdict.blinked).toBe(false);
    expect(verdict.reason).toBe("STATIC_IMAGE");
  });

  it("treats a screen's compression flicker as static too", () => {
    const flicker = [0.55, 0.552, 0.549, 0.551, 0.55, 0.5505];
    expect(Math.max(...flicker) - Math.min(...flicker)).toBeLessThan(STATIC_SPREAD);
    expect(detectBlink(flicker).reason).toBe("STATIC_IMAGE");
  });

  it("does not accept a slow droop as a blink", () => {
    // Eyes lowered and left lowered: closed, never reopened. Somebody looking
    // down at their phone, or a photo tilted away mid-capture.
    const verdict = detectBlink([0.6, 0.58, 0.45, 0.3, 0.15, 0.08, 0.06, 0.05]);
    expect(verdict.blinked).toBe(false);
    expect(verdict.reason).toBe("EYES_OPEN");
  });

  it("does not accept a capture that only ever opens at the end", () => {
    // Started closed -- a hand lifted off the lens, not a blink.
    const verdict = detectBlink([0.05, 0.06, 0.08, 0.3, 0.55, 0.6, 0.62, 0.61]);
    expect(verdict.blinked).toBe(false);
  });

  it("answers null rather than guessing when there are too few frames", () => {
    const verdict = detectBlink([0.6, 0.1, 0.6]);
    expect(verdict.blinked).toBeNull();
    expect(verdict.reason).toBe("TOO_FEW_FRAMES");
  });

  it("needs exactly MIN_FRAMES before it will answer at all", () => {
    const blink = [0.6, 0.6, 0.05, 0.6, 0.6];
    expect(blink).toHaveLength(MIN_FRAMES);
    expect(detectBlink(blink).blinked).toBe(true);
    expect(detectBlink(blink.slice(1)).blinked).toBeNull();
  });

  it("answers null when the eye was never found open in any frame", () => {
    // A dark room, or a crop that missed. Refusing somebody on this would be
    // punishing them for the camera.
    const verdict = detectBlink([0.02, 0.01, 0.03, 0.0, 0.02, 0.01]);
    expect(verdict.blinked).toBeNull();
    expect(verdict.reason).toBe("UNRELIABLE");
  });

  it("ignores frames the engine could not measure", () => {
    const withHoles = [0.6, Number.NaN, 0.6, -1, 0.05, 0.6, 0.61, 0.6];
    expect(detectBlink(withHoles).blinked).toBe(true);
  });

  it("is not fooled by one dark frame at the very end", () => {
    // The camera stopping, or a hand arriving over the lens. There is no
    // recovery after it, so it is not a blink.
    const verdict = detectBlink([...LIVE_OPEN, 0.02]);
    expect(verdict.blinked).toBe(false);
  });

  it("scales to whatever the openness units happen to be", () => {
    // The engine's absolute numbers depend on crop size and lighting, so the
    // rule is proportional throughout. The same shape ten times larger must
    // reach the same answer.
    const small = [0.06, 0.06, 0.005, 0.06, 0.06, 0.06];
    const large = small.map((v) => v * 10);
    expect(detectBlink(small).blinked).toBe(true);
    expect(detectBlink(large).blinked).toBe(true);
  });
});

// --------------------------------------------------------------- openness

/** Builds a patch: `rows` says which rows carry a dark band. */
function patch(width: number, height: number, darkRows: number[], darkWidth = width): number[] {
  const out = new Array(width * height).fill(200);
  for (const y of darkRows) {
    const start = Math.floor((width - darkWidth) / 2);
    for (let x = start; x < start + darkWidth; x++) out[y * width + x] = 30;
  }
  return out;
}

describe("patchOpenness", () => {
  it("reads an open eye as a tall dark region", () => {
    // Iris and lash line together across the middle of the patch.
    const open = patch(32, 16, [5, 6, 7, 8, 9, 10], 14);
    expect(patchOpenness(open, 32, 16)).toBeCloseTo(6 / 16, 5);
  });

  it("reads a closed eye as a single line", () => {
    const closed = patch(32, 16, [8], 20);
    expect(patchOpenness(closed, 32, 16)).toBeCloseTo(1 / 16, 5);
  });

  it("puts a closed eye far enough below an open one to register as a blink", () => {
    const open = patchOpenness(patch(32, 16, [5, 6, 7, 8, 9, 10], 14), 32, 16);
    const closed = patchOpenness(patch(32, 16, [8], 20), 32, 16);
    expect((open - closed) / open).toBeGreaterThan(BLINK_DEPTH);
  });

  it("returns zero for a patch with no contrast, rather than calling it closed", () => {
    // A blown-out or pitch-dark crop. Refusing somebody for their lighting is
    // exactly the failure this whole module is written to avoid.
    expect(patchOpenness(new Array(32 * 16).fill(200), 32, 16)).toBe(0);
    expect(patchOpenness(new Array(32 * 16).fill(0), 32, 16)).toBe(0);
  });

  it("ignores a scattering of dark pixels that is not a band", () => {
    const speckle = new Array(32 * 16).fill(200);
    for (let i = 0; i < speckle.length; i += 37) speckle[i] = 30;
    expect(patchOpenness(speckle, 32, 16)).toBe(0);
  });

  it("refuses a patch smaller than it was told", () => {
    expect(patchOpenness([1, 2, 3], 32, 16)).toBe(0);
    expect(patchOpenness([], 0, 0)).toBe(0);
  });

  it("feeds detectBlink an answer it can use end to end", () => {
    // The two halves of this module, joined: patches through openness, through
    // the decision, to a verdict.
    const openFrame = patch(32, 16, [5, 6, 7, 8, 9, 10], 14);
    const shutFrame = patch(32, 16, [8], 20);
    const jitter = patch(32, 16, [5, 6, 7, 8, 9], 14);
    const series = [openFrame, jitter, openFrame, shutFrame, jitter, openFrame, openFrame].map((f) =>
      patchOpenness(f, 32, 16),
    );
    expect(detectBlink(series).blinked).toBe(true);
  });
});
