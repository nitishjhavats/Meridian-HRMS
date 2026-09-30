/**
 * Employee of the Month — the arithmetic.
 *
 * The whole point of this module is that the result can be checked by hand.
 * Each parameter is min–max normalised across the eligible cohort for the month,
 * inverted where lower is better, multiplied by its weight and summed. Somebody
 * who came second can be shown the same table the app used and told exactly
 * which figure cost them, which turns "why did they win" from a grievance into
 * an arithmetic dispute about one number.
 *
 * Normalising is what makes the weights mean what they say. Adding ₹5,00,000 of
 * sales to 22 present days produces a number with no meaning; putting both on
 * 0–1 first means a 60/40 split really is sixty–forty.
 *
 * Pure: no Prisma, no context, no clock. Eligibility, cooldown and where the
 * raw figures came from are all the service's problem — this is handed a cohort
 * and returns a ranking.
 */

export type RecognitionDirection = "HIGHER_IS_BETTER" | "LOWER_IS_BETTER";

/**
 * Five is the ceiling and three is the suggestion.
 *
 * Past a handful of parameters nobody can explain to a person why they did not
 * win, and a recognition scheme that cannot be explained stops being one.
 */
export const MAX_PARAMETERS = 5;
export const SUGGESTED_PARAMETERS = 3;
export const REQUIRED_WEIGHT_TOTAL = 100;

/** Decimal places the normalised figure and the total are held to. */
const NORMALISED_PLACES = 5;
const TOTAL_PLACES = 2;
/**
 * Places the weight total is settled at before it is compared with 100.
 *
 * Every route into this module validates weights as whole numbers, so the sum
 * ought to be exact. Rounding anyway is what stops a stray fractional weight
 * turning "these add up to 100" into a comparison against 99.99999999999999 —
 * a scheme silently refusing to save, with an error message saying the weights
 * add up to a hundred. Six places is far tighter than any weight anybody would
 * type, so a configuration that is genuinely a hundredth out still fails.
 */
const WEIGHT_PLACES = 6;

export interface ScoringParameter {
  id: string;
  name: string;
  /** Share of the final score, 0–100. The active set must total 100. */
  weight: number;
  direction: RecognitionDirection;
}

export interface CohortMember {
  employeeId: string;
  /**
   * The raw figure per parameter id. Absent, null or non-finite all mean
   * "nothing was entered", which is not the same as a zero somebody typed.
   */
  values: Readonly<Record<string, number | null | undefined>>;
  /**
   * Days present in the month. Second tie-break, and deliberately separate from
   * the parameters: an organisation that does not score attendance still wants
   * a tie decided by who actually turned up.
   */
  attendanceDays: number;
  /** `YYYY-MM-DD`. Third tie-break — the person who has been here longer. */
  joiningDate: string;
}

export interface ScoringOptions {
  /**
   * Keep only this many places. Normalisation still uses the whole cohort, so
   * trimming the list never changes anybody's score — only how many are shown.
   */
  topN?: number;
}

export interface ParameterBreakdown {
  parameterId: string;
  /** What was entered, or null when nothing was. */
  raw: number | null;
  /** Scores zero, and the employee is named so it gets fixed rather than ignored. */
  missing: boolean;
  /** 0–1 within the cohort, direction already applied. */
  normalised: number;
  weight: number;
  /** `normalised × weight` — the number that actually moved the total. */
  contribution: number;
  /**
   * Every one of the cohort had a figure and they were all the same, so this
   * parameter gave full marks to everybody and separated nobody.
   *
   * False when anybody's figure was missing, even if the figures that *were*
   * entered all agreed: full marks to those who had one and zero to those who
   * did not is the parameter deciding the month outright, which is the opposite
   * of what this flag tells the screen to say.
   */
  uniform: boolean;
}

export type TieBreakReason = "PARAMETER" | "ATTENDANCE" | "JOINING_DATE" | "STABLE_ORDER";

export interface TieBreak {
  /** The other employees on exactly the same total. */
  tiedWith: string[];
  /**
   * What placed this row below the one above it on the same total. Null for the
   * top of a tie group: it lost to nobody.
   */
  reason: TieBreakReason | null;
  /** Set when `reason` is PARAMETER — which one separated them. */
  parameterId: string | null;
}

export interface RankedEmployee {
  employeeId: string;
  /** 1-based. Ties are always broken, so no two rows share a rank. */
  rank: number;
  /** 0–100 when the weights total 100, held to two places. */
  totalScore: number;
  breakdown: ParameterBreakdown[];
  /** Parameters this person had no figure for. Surfaced in the preview. */
  missingParameterIds: string[];
  /** Null unless somebody else finished on the same total. */
  tie: TieBreak | null;
}

export interface ScoredParameter extends ScoringParameter {
  /** Lowest and highest entered figures; null when nobody had one. */
  min: number | null;
  max: number | null;
  /** How many of the cohort had a figure at all. */
  entered: number;
  /** Everybody had a figure and it was the same one, so it cannot decide the month. */
  uniform: boolean;
}

export interface ScoringResult {
  /** In the order they were scored and displayed: heaviest first. */
  parameters: ScoredParameter[];
  ranked: RankedEmployee[];
  /** Everybody missing at least one figure, so the gaps can be filled before publishing. */
  incomplete: { employeeId: string; parameterIds: string[] }[];
  weightsTotal: number;
  weightsValid: boolean;
}

/* -------------------------------------------------------------- arithmetic */

/**
 * Rounds half up at a fixed number of places.
 *
 * `toFixed` first because binary floating point puts 0.145 × 100 at
 * 14.499999999999998, which would round down and leave the stored figure
 * disagreeing with the one on screen — exactly the sort of unexplainable
 * discrepancy this feature exists to avoid.
 */
function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(Number((value * factor).toFixed(6))) / factor;
}

function entered(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function totalWeight(parameters: readonly ScoringParameter[]): number {
  return round(
    parameters.reduce((sum, p) => sum + (Number.isFinite(p.weight) ? p.weight : 0), 0),
    WEIGHT_PLACES,
  );
}

export function weightsAreValid(parameters: readonly ScoringParameter[]): boolean {
  return totalWeight(parameters) === REQUIRED_WEIGHT_TOTAL;
}

/**
 * Heaviest first, then by name, then by id.
 *
 * This order is both the display order and the tie-break order, and it must not
 * depend on the order rows came back from the database — two runs of the same
 * month have to produce the same ranking.
 */
function inScoringOrder(parameters: readonly ScoringParameter[]): ScoringParameter[] {
  return [...parameters].sort(
    (a, b) => b.weight - a.weight || byName(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * Case-insensitive, then exact, then nothing — and deliberately not
 * `localeCompare`.
 *
 * Collation depends on the locale and on which ICU data the runtime was built
 * with, so two servers can disagree about whether "Écarts" sorts before
 * "Escalations". Where two parameters carry the same weight that disagreement
 * decides which of them breaks a tie, and the ranking a person is shown would
 * depend on the machine that drew it. `toLowerCase` is Unicode's own mapping,
 * not the host's, so this orders the same everywhere.
 */
function byName(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Scored {
  member: CohortMember;
  breakdown: ParameterBreakdown[];
  normalised: Map<string, number>;
  total: number;
}

interface Comparison {
  order: number;
  reason: TieBreakReason | null;
  parameterId: string | null;
}

/**
 * The full ordering, tie-breaks included.
 *
 * Never random, and never left to the array's incoming order: a tie broken by
 * chance cannot be explained to the person it went against, and one broken by
 * row order silently changes when somebody's name is edited.
 */
function compare(a: Scored, b: Scored, parameters: readonly ScoringParameter[]): Comparison {
  if (a.total !== b.total) return { order: b.total - a.total, reason: null, parameterId: null };

  // 1. The heaviest parameter, which is the one the organisation said mattered most.
  for (const parameter of parameters) {
    const left = a.normalised.get(parameter.id) ?? 0;
    const right = b.normalised.get(parameter.id) ?? 0;
    if (left !== right) {
      return { order: right - left, reason: "PARAMETER", parameterId: parameter.id };
    }
  }

  // 2. Who actually turned up.
  if (a.member.attendanceDays !== b.member.attendanceDays) {
    return {
      order: b.member.attendanceDays - a.member.attendanceDays,
      reason: "ATTENDANCE",
      parameterId: null,
    };
  }

  // 3. Length of service, earlier joiner first.
  if (a.member.joiningDate !== b.member.joiningDate) {
    return {
      order: a.member.joiningDate < b.member.joiningDate ? -1 : 1,
      reason: "JOINING_DATE",
      parameterId: null,
    };
  }

  // 4. Nothing separated them. The id keeps the answer stable across runs,
  //    which is the only property that matters once every rule has been spent.
  return {
    order: a.member.employeeId < b.member.employeeId ? -1 : a.member.employeeId > b.member.employeeId ? 1 : 0,
    reason: "STABLE_ORDER",
    parameterId: null,
  };
}

/* ------------------------------------------------------------------ scoring */

export function scoreCohort(
  parameters: readonly ScoringParameter[],
  cohort: readonly CohortMember[],
  options: ScoringOptions = {},
): ScoringResult {
  const ordered = inScoringOrder(parameters);

  // Min and max come from the figures that exist. A missing value left in would
  // drag the floor to zero and quietly rescale everybody else's score.
  const scored: ScoredParameter[] = ordered.map((parameter) => {
    // Folded rather than spread into Math.min: `Math.min(...values)` is an
    // argument per employee, which stops being a function call and starts being
    // a stack overflow somewhere in the tens of thousands.
    let min: number | null = null;
    let max: number | null = null;
    let count = 0;

    for (const member of cohort) {
      const value = member.values[parameter.id];
      if (!entered(value)) continue;
      count += 1;
      if (min === null || value < min) min = value;
      if (max === null || value > max) max = value;
    }

    return {
      ...parameter,
      min,
      max,
      entered: count,
      // Uniform has to mean "this separated nobody", and that is only true when
      // everybody had a figure. Where one is missing, the max === min branch
      // below hands full marks to whoever had one and zero to whoever did not:
      // the parameter decides the month by itself, and the screen would be
      // announcing that it decided nothing.
      uniform: count > 0 && count === cohort.length && min === max,
    };
  });

  const rows: Scored[] = cohort.map((member) => {
    const normalised = new Map<string, number>();
    const breakdown = scored.map((parameter) => {
      const raw = member.values[parameter.id];
      const has = entered(raw);

      let value = 0;
      if (has && parameter.min !== null && parameter.max !== null) {
        if (parameter.max === parameter.min) {
          // Everybody who has a figure has the same one. Dividing by the spread
          // would be a division by zero, and scoring them all zero would make a
          // parameter nobody differs on decide the month. Full marks all round:
          // it cancels out of the ranking, which is what "nobody differs" means.
          value = 1;
        } else {
          const span = parameter.max - parameter.min;
          value =
            parameter.direction === "LOWER_IS_BETTER"
              ? (parameter.max - raw) / span
              : (raw - parameter.min) / span;
        }
      }

      const rounded = round(value, NORMALISED_PLACES);
      normalised.set(parameter.id, rounded);

      return {
        parameterId: parameter.id,
        raw: has ? raw : null,
        missing: !has,
        normalised: rounded,
        weight: parameter.weight,
        contribution: round(rounded * parameter.weight, TOTAL_PLACES),
        uniform: parameter.uniform,
      } satisfies ParameterBreakdown;
    });

    // Summed from the rounded contributions rather than the raw products, so
    // the column on screen adds up to the total beside it.
    const total = round(
      breakdown.reduce((sum, b) => sum + b.contribution, 0),
      TOTAL_PLACES,
    );

    return { member, breakdown, normalised, total };
  });

  rows.sort((a, b) => compare(a, b, ordered).order);

  // Who else finished on the same total, and what separated them.
  const sameTotal = new Map<number, string[]>();
  for (const row of rows) {
    const bucket = sameTotal.get(row.total);
    if (bucket) bucket.push(row.member.employeeId);
    else sameTotal.set(row.total, [row.member.employeeId]);
  }

  const ranked: RankedEmployee[] = rows.map((row, index) => {
    const group = sameTotal.get(row.total) ?? [];
    const previous = index > 0 ? rows[index - 1] : undefined;
    const lostTo = previous && previous.total === row.total ? compare(previous, row, ordered) : null;

    return {
      employeeId: row.member.employeeId,
      rank: index + 1,
      totalScore: row.total,
      breakdown: row.breakdown,
      missingParameterIds: row.breakdown.filter((b) => b.missing).map((b) => b.parameterId),
      tie:
        group.length > 1
          ? {
              tiedWith: group.filter((id) => id !== row.member.employeeId),
              reason: lostTo?.reason ?? null,
              parameterId: lostTo?.parameterId ?? null,
            }
          : null,
    };
  });

  const weights = totalWeight(ordered);

  return {
    parameters: scored,
    ranked: options.topN != null ? ranked.slice(0, Math.max(0, options.topN)) : ranked,
    // From the whole cohort, never the trimmed list: a gap in somebody's figures
    // is worth fixing whether or not they were in contention.
    incomplete: ranked
      .filter((r) => r.missingParameterIds.length > 0)
      .map((r) => ({ employeeId: r.employeeId, parameterIds: r.missingParameterIds })),
    weightsTotal: weights,
    weightsValid: weights === REQUIRED_WEIGHT_TOTAL,
  };
}
