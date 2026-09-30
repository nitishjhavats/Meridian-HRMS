/**
 * Advice drawn from the picture itself, while somebody is standing in front of
 * the camera.
 *
 * Two things stop a face being recognised that the person can fix on the spot:
 * it is too dark to see them, or there is so much light behind them that they
 * are a silhouette. Anything more specific — "your face is too far away" —
 * needs a detector on the client, and a verdict computed in a browser is a
 * verdict that can be forged. So this reads brightness and nothing else, and
 * the actual decision stays on the server.
 *
 * Pure, and its own module, because it had been written once inside the phone's
 * check-in panel and the reception screen never got it: the kiosk's only piece
 * of live guidance was a hardcoded "Blink now". A person standing at a badly
 * lit reception desk was told "that photo was too blurry or dark to check"
 * *after* submitting, with no idea what to change.
 */

/** Below this the frame is too dark for a face to be found in it. */
export const DARK_MEAN = 45;
/** Above this the subject is a silhouette against a window. */
export const BLOWN_MEAN = 215;

export const FRAME_HINTS = {
  DARK: "Too dark to see your face — move somewhere brighter",
  BACKLIT: "Too much light behind you — turn away from the window",
} as const;

/**
 * Mean Rec. 601 luma of an RGBA buffer.
 *
 * Rec. 601 rather than 709 because at a 32×32 sample the difference is far
 * below the thresholds, and it is much cheaper to compute once a second on a
 * five-year-old reception tablet.
 */
export function meanLuma(rgba: ArrayLike<number>): number {
  if (rgba.length < 4) return 0;
  let sum = 0;
  const pixels = Math.floor(rgba.length / 4);
  for (let i = 0; i < pixels * 4; i += 4) {
    sum += 0.299 * (rgba[i] ?? 0) + 0.587 * (rgba[i + 1] ?? 0) + 0.114 * (rgba[i + 2] ?? 0);
  }
  return sum / pixels;
}

/** What to tell somebody about the light, or nothing if the light is fine. */
export function frameHintFor(mean: number): string | null {
  if (!Number.isFinite(mean)) return null;
  if (mean < DARK_MEAN) return FRAME_HINTS.DARK;
  if (mean > BLOWN_MEAN) return FRAME_HINTS.BACKLIT;
  return null;
}
