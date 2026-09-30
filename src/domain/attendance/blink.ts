/**
 * Deciding whether somebody blinked, from a series of eye-openness readings.
 *
 * **Why this is a series and not a frame.** Face matching answers "is this the
 * right person"; it cannot answer "is this a person". A printed photograph of
 * the right employee matches perfectly, and both capture paths in this product
 * took a single still frame -- so a print-out held up to the camera passed
 * every check there was, `REQUIRED` included.
 *
 * **Why openness and not an eye-aspect ratio.** The usual recipe needs six
 * points around each eyelid. YuNet, the detector already in this product, gives
 * five landmarks for the whole face -- eye *centres*, nose, mouth corners --
 * and no eyelid contour at all. The alternative was a second landmark model:
 * another 30 MB of unpinned third-party weights on the check-in path, for a
 * number this can get from the crop we already have. `lib/face/engine`
 * measures how much of a patch around each eye is dark, which collapses when
 * the lid closes; this decides what the resulting curve means.
 *
 * Pure, because it is the rule, and because a liveness check that refuses real
 * employees costs somebody a day's pay -- so every threshold here is pinned by
 * a test rather than tuned by hand until a demo worked.
 */

/** Openness readings in capture order, each roughly 0..1. */
export type OpennessSeries = readonly number[];

export interface BlinkVerdict {
  /**
   * `true` a blink was seen, `false` the eyes stayed open the whole time,
   * **`null` the series could not answer** -- too few frames, or readings so
   * erratic that any answer would be a guess.
   *
   * Null is not a failure of the employee's, and callers must not treat it as
   * one: `evaluateFaceMatch` routes it to `ENGINE_UNAVAILABLE`, which records
   * and flags rather than refusing.
   */
  blinked: boolean | null;
  /** How far the eyes closed, as a fraction of their open state. 0 = not at all. */
  depth: number;
  /** Why, in one word, for the log and the on-screen hint. */
  reason: "BLINKED" | "EYES_OPEN" | "STATIC_IMAGE" | "TOO_FEW_FRAMES" | "UNRELIABLE";
}

/** Fewer than this and there is nothing to compare against. */
export const MIN_FRAMES = 5;

/**
 * How far openness must fall below the open baseline to count as a blink.
 *
 * Chosen high on purpose. A half-closed eye during a yawn or a downward glance
 * dips perhaps 20%; a real blink takes the lid the whole way and the dark iris
 * disappears from the patch entirely, which is a fall of well over half. The
 * cost of setting this too low is worse than setting it too high: too low and a
 * static photo with a compression flicker reads as alive.
 */
export const BLINK_DEPTH = 0.45;

/**
 * Below this much variation across the whole series, nothing moved.
 *
 * This is the signal that actually catches a photograph. A living face never
 * holds still -- the eyes drift, the lids tighten, the head moves a millimetre
 * -- so a series that is flat to within a percent is a picture of a face, not a
 * face. It is reported separately from "you did not blink" because they need
 * different words on screen.
 */
export const STATIC_SPREAD = 0.01;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

export function detectBlink(series: OpennessSeries): BlinkVerdict {
  const usable = series.filter((v) => Number.isFinite(v) && v >= 0);
  if (usable.length < MIN_FRAMES) {
    return { blinked: null, depth: 0, reason: "TOO_FEW_FRAMES" };
  }

  const open = median(usable);
  const lowest = Math.min(...usable);
  const highest = Math.max(...usable);

  // A baseline at or below zero means the eyes were never found open in any
  // frame -- the patch was too dark, the face was turned away, or the crop
  // missed. Nothing here can be trusted either way.
  if (open <= 0.05) {
    return { blinked: null, depth: 0, reason: "UNRELIABLE" };
  }

  const depth = (open - lowest) / open;

  if (highest - lowest < STATIC_SPREAD) {
    // Identical frames. Not "you did not blink" -- "this is not a live face".
    return { blinked: false, depth, reason: "STATIC_IMAGE" };
  }

  if (depth < BLINK_DEPTH) {
    return { blinked: false, depth, reason: "EYES_OPEN" };
  }

  /**
   * A blink closes *and reopens*. Requiring the recovery is what separates a
   * blink from somebody simply lowering their eyes for the rest of the capture,
   * and from a frame that went dark because the camera was covered.
   */
  const trough = usable.indexOf(lowest);
  const recovered = usable.slice(trough + 1).some((v) => v >= open * (1 - BLINK_DEPTH / 2));
  const startedOpen = usable.slice(0, trough).some((v) => v >= open * (1 - BLINK_DEPTH / 2));

  if (!startedOpen || !recovered) {
    return { blinked: false, depth, reason: "EYES_OPEN" };
  }

  return { blinked: true, depth, reason: "BLINKED" };
}

/**
 * How open an eye is, from a small grayscale patch centred on it.
 *
 * There is no eyelid landmark to measure between, so this measures the thing an
 * eyelid actually does to the picture: an open eye puts a tall dark region --
 * iris, pupil, lash line, the shadow of the socket -- across the middle of the
 * patch, and a closed one leaves a single dark line. Counting how many *rows*
 * of the patch contain dark pixels tracks that directly, and is far steadier
 * than counting dark pixels, which moves with brightness and skin tone.
 *
 * The result is a fraction of the patch height, so it is comparable frame to
 * frame within one capture. It is **not** comparable between people or between
 * cameras, which is why `detectBlink` only ever uses it proportionally.
 *
 * Returns 0 for a patch with no contrast at all -- a blown-out or pitch-dark
 * crop, which `detectBlink` then reports as unreliable rather than as a blink.
 */
export function patchOpenness(gray: ArrayLike<number>, width: number, height: number): number {
  if (width <= 0 || height <= 0 || gray.length < width * height) return 0;

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < width * height; i++) {
    const v = gray[i] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }

  // Nothing to threshold against. Flat grey is not a closed eye, it is a bad
  // crop, and calling it "closed" would refuse somebody for their lighting.
  if (!Number.isFinite(min) || max - min < 8) return 0;

  const threshold = min + (max - min) * 0.35;
  const minDarkPerRow = Math.max(2, Math.round(width * 0.12));

  let darkRows = 0;
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x++) {
      if ((gray[y * width + x] as number) <= threshold) dark++;
    }
    if (dark >= minDarkPerRow) darkRows++;
  }

  return darkRows / height;
}
