import { formatMoney, formatNumber } from "@/lib/utils";

/**
 * How a recognition figure is written down.
 *
 * The same column holds rupees, counts, percentages and hours, so the unit is
 * what tells a reader whether "8" is eight sales or eight per cent. Both the
 * public screen and the settings screen format through here, because a figure
 * that reads as ₹8 on one page and 8% on the other is worse than no figure.
 */

export type RecognitionUnitKey = "RUPEES" | "COUNT" | "PERCENT" | "HOURS" | "POINTS";
export type RecognitionSourceKey =
  | "MANUAL"
  | "PRESENT_DAYS"
  | "PUNCTUALITY"
  | "OVERTIME_HOURS"
  | "GOALS_COMPLETED";

export const UNIT_LABELS: Record<RecognitionUnitKey, string> = {
  RUPEES: "Rupees",
  COUNT: "Count",
  PERCENT: "Percentage",
  HOURS: "Hours",
  POINTS: "Points",
};

export const SOURCE_LABELS: Record<RecognitionSourceKey, string> = {
  MANUAL: "Entered each month",
  PRESENT_DAYS: "Days present",
  PUNCTUALITY: "On-time percentage",
  OVERTIME_HOURS: "Overtime hours",
  GOALS_COMPLETED: "Goals completed",
};

/** What the app will fill in, and from where, so nobody goes looking for a field to type in. */
export const SOURCE_HINTS: Record<RecognitionSourceKey, string> = {
  MANUAL: "You enter this figure for each person once the month is over.",
  PRESENT_DAYS: "Counted from attendance: days marked present, on duty, training or an extra day.",
  PUNCTUALITY: "Counted from attendance: days with no late minutes, as a percentage of days present.",
  OVERTIME_HOURS: "Counted from attendance: overtime minutes in the month, converted to hours.",
  GOALS_COMPLETED: "Counted from performance: goals marked achieved during the month.",
};

/** The unit a derived source always produces. A count of days is not rupees. */
export const SOURCE_UNIT: Record<RecognitionSourceKey, RecognitionUnitKey | null> = {
  MANUAL: null,
  PRESENT_DAYS: "COUNT",
  PUNCTUALITY: "PERCENT",
  OVERTIME_HOURS: "HOURS",
  GOALS_COMPLETED: "COUNT",
};

/**
 * A raw figure, written the way its unit means it.
 *
 * Rupees are the one awkward case: this is the only number in the product that
 * is *not* integer paise, because the same column also holds percentages and
 * hours and it is never paid out. So it is converted at the last moment, here.
 */
export function formatRecognitionValue(
  value: number | null | undefined,
  unit: RecognitionUnitKey,
  currency = "INR",
): string {
  if (value == null || !Number.isFinite(value)) return "—";

  switch (unit) {
    case "RUPEES":
      return formatMoney(Math.round(value * 100), currency);
    case "PERCENT":
      return `${formatNumber(Number(value.toFixed(1)))}%`;
    case "HOURS":
      return `${formatNumber(Number(value.toFixed(1)))} h`;
    default:
      return formatNumber(Number(value.toFixed(2)));
  }
}
