import type { RecognitionUnitKey } from "../recognition/units";

/**
 * How far along a goal is.
 *
 * `Goal.targetValue` and `currentValue` were free text from the day the model
 * was written, and null on every goal in production — the three that exist say
 * what they are worth in their title, "Sales 1 lakh". Nothing computed a
 * percentage because there was nothing to compute one from, and
 * `GoalStatus.ACHIEVED` was rendered by the list and reachable from nowhere.
 *
 * The unit vocabulary is Employee of the Month's, on purpose. A second list
 * would be a second place to add "hours" to, and they would drift.
 */

export interface GoalMeasure {
  unit: RecognitionUnitKey | null;
  target: number | null;
  current: number | null;
}

/**
 * The percentage, or null when the goal is not the kind that has one.
 *
 * Null rather than zero for a goal with no target: a text goal showing "0%"
 * reads as somebody who has done nothing, when in fact nobody ever said what
 * finished would look like.
 *
 * A zero target is also null. Dividing by it gives Infinity, and "achieved
 * ∞% of a goal of nothing" is not a sentence to put on a screen.
 */
export function goalPercent(measure: GoalMeasure): number | null {
  const { target, current } = measure;
  if (target === null || !Number.isFinite(target) || target === 0) return null;
  if (current === null || !Number.isFinite(current)) return 0;

  const raw = (current / target) * 100;
  if (!Number.isFinite(raw)) return null;
  // Overshooting is real and worth seeing — a target beaten by half again is
  // 150%, not 100%. Negative progress is clamped, because a bar cannot be less
  // than empty and a negative sale is a correction, not an achievement.
  return Math.max(0, Math.round(raw * 10) / 10);
}

/** Whether the goal has reached what it was set to reach. */
export function goalIsMet(measure: GoalMeasure): boolean {
  const percent = goalPercent(measure);
  return percent !== null && percent >= 100;
}

/**
 * What a progress entry is allowed to be.
 *
 * Rejected rather than clamped. Somebody typing 6000000 where they meant 60000
 * has made a mistake, and quietly capping it at the target would hide the
 * mistake behind a full progress bar.
 */
export function validateProgressValue(
  value: unknown,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, reason: "Give a number for where the goal has got to." };
  }
  if (value < 0) {
    return { ok: false, reason: "Progress cannot be negative." };
  }
  // Two decimals, matching the column. Rounded rather than refused: nobody
  // typing 1/3 of something means to be told off about it.
  return { ok: true, value: Math.round(value * 100) / 100 };
}

/**
 * Whether this person may change the goal itself, as opposed to its progress.
 *
 * The distinction the user asked for in one line: "goal aur target edit na kar
 * sake". Somebody who was handed a goal moves the number that says how far they
 * have got and nothing else — otherwise a target is a suggestion.
 */
export function canEditGoalDefinition(input: {
  isOwnGoal: boolean;
  canReview: boolean;
}): boolean {
  return input.canReview;
}

/** Whether this person may record progress against it. */
export function canRecordProgress(input: {
  isOwnGoal: boolean;
  canReview: boolean;
}): boolean {
  return input.isOwnGoal || input.canReview;
}
