/**
 * Weekly-off resolution.
 *
 * Four shapes, all org-configurable and overridable per employee:
 *   FIXED      — one weekday off every week            { days: [0] }
 *   MULTIPLE   — several weekdays off every week        { days: [0, 6] }
 *   ROTATIONAL — some weekdays only on certain weeks    { days: [0], rotating: [{ day: 6, weeks: [2, 4] }] }
 *   CUSTOM     — an explicit list of dates              { dates: ["2026-01-04"] }
 *
 * `weeks` entries are 1-based occurrences of that weekday inside the month, which
 * is how Indian organisations actually express "2nd and 4th Saturday". The
 * alternative `isoParity` handles "alternate Saturdays" driven by ISO week number.
 */

import { type DateOnly, dayOfWeek, isoWeekNumber, weekdayOccurrenceInMonth } from "../date";

export type WeeklyOffType = "FIXED" | "MULTIPLE" | "ROTATIONAL" | "CUSTOM";

export interface RotatingRule {
  /** 0 = Sunday … 6 = Saturday */
  day: number;
  /** 1-based occurrence within the month, e.g. [2, 4] = 2nd and 4th. */
  weeks?: number[];
  /** Alternative to `weeks`: off on odd or even ISO weeks. */
  isoParity?: "ODD" | "EVEN";
}

export interface WeeklyOffConfig {
  type: WeeklyOffType;
  /** Weekdays off every week. */
  days?: number[];
  /** Weekdays off only on certain occurrences. */
  rotating?: RotatingRule[];
  /** Explicit dates (CUSTOM). */
  dates?: DateOnly[];
}

export const DEFAULT_WEEKLY_OFF: WeeklyOffConfig = { type: "FIXED", days: [0] };

export function isWeeklyOff(date: DateOnly, config: WeeklyOffConfig): boolean {
  const dow = dayOfWeek(date);

  if (config.type === "CUSTOM") {
    return (config.dates ?? []).includes(date);
  }

  if ((config.days ?? []).includes(dow)) return true;

  if (config.type === "ROTATIONAL") {
    for (const rule of config.rotating ?? []) {
      if (rule.day !== dow) continue;
      if (rule.weeks && rule.weeks.length > 0) {
        if (rule.weeks.includes(weekdayOccurrenceInMonth(date))) return true;
      }
      if (rule.isoParity) {
        const odd = isoWeekNumber(date) % 2 === 1;
        if ((rule.isoParity === "ODD" && odd) || (rule.isoParity === "EVEN" && !odd)) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Human-readable summary for the settings UI. */
export function describeWeeklyOff(config: WeeklyOffConfig): string {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const ordinal = (n: number) =>
    n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;

  if (config.type === "CUSTOM") {
    const count = config.dates?.length ?? 0;
    return count === 0 ? "No off days configured" : `${count} custom off ${count === 1 ? "date" : "dates"}`;
  }

  const fixed = (config.days ?? []).map((d) => names[d] ?? `day ${d}`);
  const rotating = (config.rotating ?? []).map((r) => {
    const day = names[r.day] ?? `day ${r.day}`;
    if (r.weeks?.length) return `${r.weeks.map(ordinal).join(" & ")} ${day}`;
    if (r.isoParity) return `${r.isoParity === "ODD" ? "Odd" : "Even"}-week ${day}`;
    return day;
  });

  const all = [...fixed, ...rotating];
  return all.length === 0 ? "No weekly off" : all.join(", ");
}

const inRange = (d: unknown): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6;

/**
 * A person's own rest days, when they differ from every named pattern.
 *
 * Deliberately only the two plain shapes — FIXED and MULTIPLE — because that is
 * what seven day chips can say. "2nd and 4th Saturday" is a named pattern, and
 * the profile offers those beside the chips rather than growing a second
 * pattern editor.
 */
export type PersonalWeeklyOff = { type: "FIXED" | "MULTIPLE"; days: number[] };

/** Why a list of weekdays cannot be somebody's rest days. Empty means it can. */
export function personalWeeklyOffErrors(days: readonly unknown[]): string[] {
  const errors: string[] = [];
  if (days.length === 0) errors.push("Pick at least one day off.");
  for (const d of days) {
    if (!inRange(d)) errors.push(`Invalid weekday ${String(d)}; expected 0–6.`);
  }
  // Seven rest days is not a rota, it is nobody ever working — and payroll
  // would read a month of it as fully paid with nothing to prorate against.
  if (new Set(days).size === 7) errors.push("Every day cannot be a rest day.");
  return errors;
}

/** The stored shape, from the weekdays somebody picked. Deduplicated and sorted. */
export function personalWeeklyOff(days: readonly number[]): PersonalWeeklyOff {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return { type: unique.length > 1 ? "MULTIPLE" : "FIXED", days: unique };
}

/**
 * Reads `Employee.weeklyOffConfig` back, or null when there is nothing usable.
 *
 * Validated on the way out as well as on the way in. The column is JSON, and
 * a value written by an import or a script that the form never saw must fall
 * through to the pattern rather than be trusted — a config with no days would
 * otherwise make every day a working day for that person.
 */
export function readPersonalWeeklyOff(value: unknown): PersonalWeeklyOff | null {
  if (!value || typeof value !== "object") return null;
  const { type, days } = value as { type?: unknown; days?: unknown };
  if (type !== "FIXED" && type !== "MULTIPLE") return null;
  if (!Array.isArray(days) || personalWeeklyOffErrors(days).length > 0) return null;
  return personalWeeklyOff(days as number[]);
}

export function validateWeeklyOffConfig(config: WeeklyOffConfig): string[] {
  const errors: string[] = [];

  for (const d of config.days ?? []) {
    if (!inRange(d)) errors.push(`Invalid weekday ${d}; expected 0–6.`);
  }
  for (const r of config.rotating ?? []) {
    if (!inRange(r.day)) errors.push(`Invalid rotating weekday ${r.day}; expected 0–6.`);
    if (!r.weeks?.length && !r.isoParity) {
      errors.push(`Rotating rule for weekday ${r.day} needs either week numbers or a parity.`);
    }
    for (const w of r.weeks ?? []) {
      if (!Number.isInteger(w) || w < 1 || w > 5) errors.push(`Invalid week occurrence ${w}; expected 1–5.`);
    }
  }
  if (config.type === "CUSTOM" && !(config.dates?.length ?? 0)) {
    errors.push("Custom weekly-off needs at least one date.");
  }
  if (config.type === "ROTATIONAL" && !(config.rotating?.length ?? 0)) {
    errors.push("Rotational weekly-off needs at least one rotating rule.");
  }
  return errors;
}
