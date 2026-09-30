/**
 * How long the camera watches, and when it asks for the blink.
 *
 * **Measured before changing.** Of eighteen marks on the live instance in one
 * morning, sixteen were refused `NO_BLINK` — and every one of them carried
 * `faceMatchScore: null`, meaning the identity comparison never ran at all. The
 * blink gate sits above it and refused first. So "face match nahi ho raha" was
 * the blink, every time; the matching itself was scoring 0.58–0.87 the week
 * before, comfortably above the 0.363 threshold.
 *
 * **Why it was failing.** The old capture was eight frames 180 ms apart — 1.4
 * seconds — with "Blink now" appearing at the *third frame*, about 360 ms in.
 * The comment justifying it reasoned only about sampling: a blink lasts a third
 * of a second, so frames that close together cannot miss one. True, and beside
 * the point. Nobody was missing the blink; nobody had blinked yet. A person has
 * to see the words, read them, and then blink — and that takes most of the
 * second the whole capture lasted.
 *
 * **So the prompt comes first and the window is longer.** The instruction shows
 * with nothing being recorded, then the capture runs. Reaction to a visual cue
 * is a quarter-second at best and closer to a second when the words are new, so
 * the lead-in buys the reading and the window holds the blink.
 *
 * The gap stays tight for the original reason, which is still correct: a blink
 * that lasts 300 ms must not fall between two frames.
 */

/** Frames sent for the liveness check. The server cap must not be below this. */
export const BURST_FRAMES = 10;

/** Milliseconds between frames. Tight enough that a 300 ms blink cannot hide. */
export const BURST_GAP_MS = 220;

/**
 * How long "Blink now" is on screen before the first frame is taken.
 *
 * The whole of the fix. Zero here — which is what it effectively was — asks
 * somebody to have already blinked.
 */
export const BLINK_LEAD_MS = 800;

/** The window the person actually has to blink in, prompt to last frame. */
export function blinkWindowMs(): number {
  return BLINK_LEAD_MS + (BURST_FRAMES - 1) * BURST_GAP_MS;
}

/**
 * A rough seconds figure for the screen, so the countdown and the capture agree.
 *
 * Rounded up: telling somebody "2 seconds" and stopping at 2.8 reads as the
 * camera hanging.
 */
export function blinkWindowSeconds(): number {
  return Math.ceil(blinkWindowMs() / 1000);
}
