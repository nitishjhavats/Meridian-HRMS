/**
 * The two decisions a numeric input has to make, without React in the way.
 *
 * Both were being made wrong, in the same line, on roughly forty fields:
 *
 *     onChange={(e) => setCount(Number(e.target.value))}
 *
 * `Number("")` is `0`, so clearing the box put a zero back in it — and with the
 * common variants (`|| 1`, a `Math.max` clamp, a "sensible default") the stuck
 * value was a 1, a 2048, or the current year. The reported symptom was exact:
 * backspacing leaves one digit that will not delete, so a value has to be typed
 * around it and the leftover removed afterwards.
 *
 * Pure and here so they can be tested at all: the component is a client
 * component and this repo has no DOM test setup, and a rule this easy to get
 * wrong should not be pinned only by a source-guard.
 */

/**
 * Whether this is something a person could be part-way through typing.
 *
 * Deliberately permissive. "", "0", "1." and "12.5" are all legitimate states
 * of a text box on the way to a number, and rejecting any of them mid-word is
 * the same class of bug as coercing on every keystroke — the box fights the
 * person typing into it.
 */
export function isPartialNumber(raw: string, decimals: number): boolean {
  if (raw === "") return true;
  if (decimals <= 0) return /^\d*$/.test(raw);
  return new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`).test(raw);
}

export interface NormaliseOptions {
  min?: number;
  max?: number;
  decimals?: number;
  /** What to fall back to when the text is not a number at all. */
  fallback?: number | null;
}

/**
 * What the box settles on when it is left.
 *
 * Clamping happens **here and not while typing**, which is the other half of
 * the bug: with `min={1}`, clamping each keystroke turns "10" into "1" → clamp
 * → "1", and the zero is eaten as it is typed. A range is a property of a
 * committed value, not of a half-typed one.
 *
 * Empty stays `null` rather than becoming zero. Several of these fields need
 * the difference — a blank "free late marks" is not the same as zero of them —
 * and the caller is the only thing that knows which it is.
 */
export function normaliseNumber(raw: string, options: NormaliseOptions = {}): number | null {
  const text = raw.trim();
  if (text === "") return null;

  let next = Number(text);
  if (!Number.isFinite(next)) return options.fallback ?? null;

  if (options.min !== undefined) next = Math.max(options.min, next);
  if (options.max !== undefined) next = Math.min(options.max, next);
  if ((options.decimals ?? 0) <= 0) next = Math.round(next);

  return next;
}
