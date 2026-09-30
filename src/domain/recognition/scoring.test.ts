import { describe, expect, it } from "vitest";
import {
  type CohortMember,
  type ScoringParameter,
  REQUIRED_WEIGHT_TOTAL,
  scoreCohort,
  totalWeight,
  weightsAreValid,
} from "./scoring";

const parameter = (
  id: string,
  weight: number,
  direction: ScoringParameter["direction"] = "HIGHER_IS_BETTER",
  name = id,
): ScoringParameter => ({ id, name, weight, direction });

const member = (
  employeeId: string,
  values: Record<string, number | null | undefined>,
  extra: Partial<Pick<CohortMember, "attendanceDays" | "joiningDate">> = {},
): CohortMember => ({
  employeeId,
  values,
  attendanceDays: extra.attendanceDays ?? 20,
  joiningDate: extra.joiningDate ?? "2024-01-01",
});

const order = (result: ReturnType<typeof scoreCohort>) => result.ranked.map((r) => r.employeeId);
const totals = (result: ReturnType<typeof scoreCohort>) => result.ranked.map((r) => r.totalScore);

describe("scoreCohort", () => {
  it("normalises, weights and sums to a score out of 100", () => {
    const result = scoreCohort(
      [parameter("sales", 60), parameter("shrinkage", 40, "LOWER_IS_BETTER")],
      [
        member("a", { sales: 100, shrinkage: 10 }),
        member("b", { sales: 50, shrinkage: 5 }),
        member("c", { sales: 0, shrinkage: 20 }),
      ],
    );

    // sales spans 0–100, shrinkage 5–20 and is inverted.
    expect(order(result)).toEqual(["a", "b", "c"]);
    expect(totals(result)).toEqual([86.67, 70, 0]);
    expect(result.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it("shows the working for every parameter, not just the total", () => {
    const result = scoreCohort(
      [parameter("sales", 100)],
      [member("a", { sales: 20 }), member("b", { sales: 10 })],
    );

    expect(result.ranked[0]?.breakdown).toEqual([
      {
        parameterId: "sales",
        raw: 20,
        missing: false,
        normalised: 1,
        weight: 100,
        contribution: 100,
        uniform: false,
      },
    ]);
    expect(result.parameters[0]).toMatchObject({ min: 10, max: 20, entered: 2, uniform: false });
  });

  it("orders parameters heaviest first, whatever order they arrive in", () => {
    const result = scoreCohort(
      [parameter("small", 10), parameter("big", 90)],
      [member("a", { small: 1, big: 1 })],
    );
    expect(result.parameters.map((p) => p.id)).toEqual(["big", "small"]);
  });

  /* ------------------------------------------------------ everyone the same */

  it("gives everybody full marks when nobody differs, rather than dividing by zero", () => {
    const result = scoreCohort(
      [parameter("tickets", 100)],
      [
        member("a", { tickets: 7 }, { attendanceDays: 22 }),
        member("b", { tickets: 7 }, { attendanceDays: 20 }),
        member("c", { tickets: 7 }, { attendanceDays: 21 }),
      ],
    );

    expect(totals(result)).toEqual([100, 100, 100]);
    expect(result.parameters[0]?.uniform).toBe(true);
    expect(result.ranked.every((r) => r.breakdown[0]?.normalised === 1)).toBe(true);
    // Nobody differs on it, so it cannot decide the month — attendance does.
    expect(order(result)).toEqual(["a", "c", "b"]);
    expect(result.ranked[1]?.tie?.reason).toBe("ATTENDANCE");
  });

  it("still ranks on the other parameters when one is uniform", () => {
    const result = scoreCohort(
      [parameter("sales", 50), parameter("tickets", 50)],
      [member("a", { sales: 10, tickets: 7 }), member("b", { sales: 4, tickets: 7 })],
    );

    expect(totals(result)).toEqual([100, 50]);
    expect(order(result)).toEqual(["a", "b"]);
  });

  /* ---------------------------------------------------------- one person */

  it("scores a single eligible employee full marks", () => {
    const result = scoreCohort(
      [parameter("sales", 60), parameter("escalations", 40, "LOWER_IS_BETTER")],
      [member("only", { sales: 250_000, escalations: 3 })],
    );

    expect(totals(result)).toEqual([100]);
    expect(result.ranked[0]?.tie).toBeNull();
    expect(result.incomplete).toEqual([]);
  });

  /* -------------------------------------------------------- missing values */

  it("scores a missing value zero and names the employee", () => {
    const result = scoreCohort(
      [parameter("sales", 100)],
      [
        member("a", { sales: 10 }, { attendanceDays: 22 }),
        member("b", { sales: 20 }),
        member("c", {}, { attendanceDays: 18 }),
      ],
    );

    expect(order(result)).toEqual(["b", "a", "c"]);
    expect(totals(result)).toEqual([100, 0, 0]);
    expect(result.incomplete).toEqual([{ employeeId: "c", parameterIds: ["sales"] }]);
    expect(result.ranked[2]?.breakdown[0]).toMatchObject({ raw: null, missing: true, normalised: 0 });
  });

  it("keeps a missing value out of the min and max, so it cannot rescale the cohort", () => {
    const result = scoreCohort(
      [parameter("sales", 100)],
      [member("a", { sales: 10 }), member("b", { sales: 20 }), member("c", { sales: null })],
    );

    // Were the missing figure read as a zero, the range would be 0–20 and "a"
    // would score 50 rather than 0.
    expect(result.parameters[0]).toMatchObject({ min: 10, max: 20, entered: 2 });
    expect(result.ranked.find((r) => r.employeeId === "a")?.totalScore).toBe(0);
  });

  it("treats undefined, null and a non-finite number alike as nothing entered", () => {
    const result = scoreCohort(
      [parameter("a", 40), parameter("b", 30, "HIGHER_IS_BETTER", "b"), parameter("c", 30, "HIGHER_IS_BETTER", "c")],
      [
        member("x", { a: undefined, b: null, c: Number.NaN }),
        member("y", { a: 5, b: 5, c: 5 }),
      ],
    );

    expect(result.ranked.find((r) => r.employeeId === "x")?.missingParameterIds.sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("scores nobody on a parameter no figures were entered for", () => {
    const result = scoreCohort(
      [parameter("sales", 50), parameter("audit", 50)],
      [member("a", { sales: 10 }), member("b", { sales: 5 })],
    );

    expect(result.parameters.find((p) => p.id === "audit")).toMatchObject({
      min: null,
      max: null,
      entered: 0,
      uniform: false,
    });
    expect(totals(result)).toEqual([50, 0]);
    expect(result.incomplete).toEqual([
      { employeeId: "a", parameterIds: ["audit"] },
      { employeeId: "b", parameterIds: ["audit"] },
    ]);
  });

  /* -------------------------------------------------------- direction */

  it("inverts a lower-is-better parameter", () => {
    const result = scoreCohort(
      [parameter("shrinkage", 100, "LOWER_IS_BETTER")],
      [member("a", { shrinkage: 1 }), member("b", { shrinkage: 5 }), member("c", { shrinkage: 10 })],
    );

    expect(order(result)).toEqual(["a", "b", "c"]);
    expect(totals(result)).toEqual([100, 55.56, 0]);
  });

  it("ranks lower-is-better the opposite way round from the same figures", () => {
    const cohort = [member("a", { v: 1 }), member("b", { v: 9 })];
    expect(order(scoreCohort([parameter("v", 100)], cohort))).toEqual(["b", "a"]);
    expect(order(scoreCohort([parameter("v", 100, "LOWER_IS_BETTER")], cohort))).toEqual(["a", "b"]);
  });

  /* --------------------------------------------------------- tie-breaking */

  it("breaks a tie on the highest-weighted parameter first", () => {
    const result = scoreCohort(
      [parameter("A", 60), parameter("B", 40)],
      [member("p", { A: 10, B: 10 }), member("q", { A: 5, B: 0 }), member("r", { A: 0, B: 7.5 })],
    );

    expect(totals(result)).toEqual([100, 30, 30]);
    expect(order(result)).toEqual(["p", "q", "r"]);
    expect(result.ranked[2]?.tie).toEqual({
      tiedWith: ["q"],
      reason: "PARAMETER",
      parameterId: "A",
    });
    // The top of a tie group lost to nobody, so it records no reason.
    expect(result.ranked[1]?.tie).toEqual({ tiedWith: ["r"], reason: null, parameterId: null });
    expect(result.ranked[0]?.tie).toBeNull();
  });

  it("falls to attendance when the parameters cannot separate them", () => {
    const result = scoreCohort(
      [parameter("sales", 100)],
      [
        member("a", { sales: 5 }, { attendanceDays: 18 }),
        member("b", { sales: 5 }, { attendanceDays: 22 }),
      ],
    );

    expect(order(result)).toEqual(["b", "a"]);
    expect(result.ranked[1]?.tie?.reason).toBe("ATTENDANCE");
  });

  it("falls to the earlier joining date when attendance is equal too", () => {
    const result = scoreCohort(
      [parameter("sales", 100)],
      [
        member("newer", { sales: 5 }, { attendanceDays: 20, joiningDate: "2023-06-01" }),
        member("older", { sales: 5 }, { attendanceDays: 20, joiningDate: "2019-04-15" }),
      ],
    );

    expect(order(result)).toEqual(["older", "newer"]);
    expect(result.ranked[1]?.tie?.reason).toBe("JOINING_DATE");
  });

  it("still produces a stable order when nothing at all separates two people", () => {
    const cohort = [
      member("zoe", { sales: 5 }, { attendanceDays: 20, joiningDate: "2022-02-02" }),
      member("adam", { sales: 5 }, { attendanceDays: 20, joiningDate: "2022-02-02" }),
    ];

    const forwards = scoreCohort([parameter("sales", 100)], cohort);
    const backwards = scoreCohort([parameter("sales", 100)], [...cohort].reverse());

    expect(order(forwards)).toEqual(["adam", "zoe"]);
    expect(order(backwards)).toEqual(["adam", "zoe"]);
    expect(forwards.ranked[1]?.tie?.reason).toBe("STABLE_ORDER");
  });

  it("gives the same ranking however the cohort and parameters are ordered", () => {
    const parameters = [parameter("A", 60), parameter("B", 40, "LOWER_IS_BETTER")];
    const cohort = [
      member("a", { A: 9, B: 2 }, { attendanceDays: 21, joiningDate: "2020-01-01" }),
      member("b", { A: 9, B: 4 }, { attendanceDays: 21, joiningDate: "2020-01-01" }),
      member("c", { A: 3, B: 2 }, { attendanceDays: 19, joiningDate: "2021-01-01" }),
      member("d", { A: 3, B: 2 }, { attendanceDays: 19, joiningDate: "2018-01-01" }),
    ];

    const first = scoreCohort(parameters, cohort);
    const second = scoreCohort([...parameters].reverse(), [...cohort].reverse());

    expect(order(second)).toEqual(order(first));
    expect(totals(second)).toEqual(totals(first));
  });

  it("never assigns the same rank twice, because an award has one first place", () => {
    const result = scoreCohort(
      [parameter("sales", 100)],
      [member("a", { sales: 5 }), member("b", { sales: 5 }), member("c", { sales: 5 })],
    );

    expect(result.ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(new Set(result.ranked.map((r) => r.rank)).size).toBe(3);
  });

  /* ------------------------------------------------------------ edge cases */

  it("returns nothing for an empty cohort rather than throwing", () => {
    const result = scoreCohort([parameter("sales", 100)], []);

    expect(result.ranked).toEqual([]);
    expect(result.incomplete).toEqual([]);
    expect(result.parameters[0]).toMatchObject({ min: null, max: null, entered: 0, uniform: false });
  });

  it("copes with no parameters at all", () => {
    const result = scoreCohort([], [member("a", {}), member("b", {})]);

    expect(totals(result)).toEqual([0, 0]);
    expect(result.weightsValid).toBe(false);
    expect(result.incomplete).toEqual([]);
  });

  it("trims to topN without changing anybody's score", () => {
    const parameters = [parameter("sales", 100)];
    const cohort = [
      member("a", { sales: 1 }),
      member("b", { sales: 5 }),
      member("c", { sales: 9 }),
    ];

    const full = scoreCohort(parameters, cohort);
    const trimmed = scoreCohort(parameters, cohort, { topN: 2 });

    expect(order(trimmed)).toEqual(["c", "b"]);
    expect(totals(trimmed)).toEqual(totals(full).slice(0, 2));
    // The gaps of somebody outside the top two are still worth fixing.
    expect(trimmed.incomplete).toEqual(full.incomplete);
  });

  it("does not call a parameter uniform when only some of the cohort had a figure", () => {
    // Every entered figure agrees, but two people entered nothing. Calling that
    // uniform tells the screen the parameter "decided nothing this month" while
    // it is in fact handing the entire weight to the only person with a number.
    const result = scoreCohort(
      [parameter("wins", 100)],
      [member("alice", { wins: 5 }), member("bob", {}), member("carol", { wins: null })],
    );

    expect(result.parameters[0]).toMatchObject({ min: 5, max: 5, entered: 1, uniform: false });
    expect(result.ranked.every((r) => r.breakdown[0]?.uniform === false)).toBe(true);
    // The arithmetic is unchanged: there is still no spread to divide by, so
    // the one figure there is scores full marks and the gaps score zero.
    expect(order(result)).toEqual(["alice", "bob", "carol"]);
    expect(totals(result)).toEqual([100, 0, 0]);
    expect(result.incomplete.map((r) => r.employeeId)).toEqual(["bob", "carol"]);
  });

  it("calls a parameter uniform only once every one of the cohort has the same figure", () => {
    const cohort = [member("a", { wins: 5 }), member("b", { wins: 5 }), member("c", {})];
    expect(scoreCohort([parameter("wins", 100)], cohort).parameters[0]?.uniform).toBe(false);

    const complete = [...cohort.slice(0, 2), member("c", { wins: 5 })];
    expect(scoreCohort([parameter("wins", 100)], complete).parameters[0]?.uniform).toBe(true);
  });

  it("gives everybody full marks when every figure is zero", () => {
    const result = scoreCohort(
      [parameter("escalations", 100, "LOWER_IS_BETTER")],
      [member("a", { escalations: 0 }), member("b", { escalations: 0 })],
    );

    expect(result.parameters[0]).toMatchObject({ min: 0, max: 0, uniform: true });
    expect(totals(result)).toEqual([100, 100]);
  });

  it("inverts lower-is-better at both ends, not only in the middle", () => {
    const result = scoreCohort(
      [parameter("shrinkage", 100, "LOWER_IS_BETTER")],
      [
        member("best", { shrinkage: -4 }),
        member("middle", { shrinkage: 0 }),
        member("worst", { shrinkage: 4 }),
      ],
    );

    const normalised = Object.fromEntries(
      result.ranked.map((r) => [r.employeeId, r.breakdown[0]?.normalised]),
    );
    // The floor of the range scores 1 and the ceiling scores 0 exactly; a sign
    // error or an off-by-one in the span shows up here and nowhere else.
    expect(normalised).toEqual({ best: 1, middle: 0.5, worst: 0 });
    expect(order(result)).toEqual(["best", "middle", "worst"]);
  });

  /* ------------------------------------------------------------ arithmetic */

  it("adds up to exactly one hundred, with no floating point tail", () => {
    // Three thirds and five fifths are where a sum of rounded contributions
    // usually lands on 99.99999999999999 — and the total is compared for
    // equality when tie groups are worked out, so a tail would split a tie.
    for (const weights of [
      [34, 33, 33],
      [20, 20, 20, 20, 20],
      [60, 15, 15, 10],
    ]) {
      const parameters = weights.map((w, i) => parameter(`p${i}`, w));
      const values = Object.fromEntries(parameters.map((p) => [p.id, 7]));
      const result = scoreCohort(parameters, [member("a", values), member("b", values)]);

      expect(totals(result)).toEqual([100, 100]);
      for (const total of totals(result)) expect(Object.is(total, 100)).toBe(true);
      // Same total, so they are a tie group rather than two separate scores.
      expect(result.ranked[0]?.tie?.tiedWith).toEqual(["b"]);
    }
  });

  it("holds the total to two places so the column on screen adds up to it", () => {
    const result = scoreCohort(
      [parameter("a", 60), parameter("b", 40)],
      [member("x", { a: 1, b: 2 }), member("y", { a: 3, b: 1 }), member("z", { a: 2, b: 3 })],
    );

    for (const row of result.ranked) {
      const summed = row.breakdown.reduce((sum, b) => sum + b.contribution, 0);
      expect(row.totalScore).toBe(Math.round(summed * 100) / 100);
      expect(Number(row.totalScore.toFixed(2))).toBe(row.totalScore);
    }
  });

  it("orders equal-weighted parameters the same way whatever order they arrive in", () => {
    // Equal weights mean the name decides which parameter breaks a tie first,
    // so this ordering has to be the same on every machine that runs it.
    const parameters = [
      parameter("id-z", 50, "HIGHER_IS_BETTER", "Escalations"),
      parameter("id-a", 50, "HIGHER_IS_BETTER", "escalation reviews"),
    ];

    const forwards = scoreCohort(parameters, [member("a", {})]);
    const backwards = scoreCohort([...parameters].reverse(), [member("a", {})]);

    expect(forwards.parameters.map((p) => p.name)).toEqual(backwards.parameters.map((p) => p.name));
    expect(forwards.parameters.map((p) => p.name)).toEqual(["escalation reviews", "Escalations"]);
  });

  it("scores negative figures on the same scale as positive ones", () => {
    const result = scoreCohort(
      [parameter("margin", 100)],
      [member("a", { margin: -50 }), member("b", { margin: 0 }), member("c", { margin: 50 })],
    );

    expect(order(result)).toEqual(["c", "b", "a"]);
    expect(totals(result)).toEqual([100, 50, 0]);
  });
});

/* ------------------------------------------------------------------ weights */

describe("weights", () => {
  it("adds active weights up", () => {
    expect(totalWeight([parameter("a", 50), parameter("b", 30), parameter("c", 20)])).toBe(100);
  });

  it("settles the total before comparing it, so a float tail cannot refuse a valid set", () => {
    // Every route into the module validates whole numbers, so this should never
    // arise — but an exact === against a sum carrying 1e-13 of binary tail is a
    // scheme that refuses to save with an error saying it adds up to 100.
    // 0.2 + 83.9 + 15.9 is 100.00000000000001 in binary floating point, and
    // 0.1 + 64.1 + 35.8 is 99.99999999999999.
    for (const weights of [
      [0.2, 83.9, 15.9],
      [0.1, 64.1, 35.8],
    ]) {
      const drifting = weights.map((w, i) => parameter(`p${i}`, w));
      expect(weights.reduce((sum, w) => sum + w, 0)).not.toBe(100); // the raw sum really is off
      expect(totalWeight(drifting)).toBe(100);
      expect(weightsAreValid(drifting)).toBe(true);
    }

    // A set that is genuinely out is still out, tail or no tail.
    expect(weightsAreValid([parameter("a", 33.3), parameter("b", 33.3), parameter("c", 33.3)])).toBe(
      false,
    );
    expect(weightsAreValid([parameter("a", 50), parameter("b", 49.999)])).toBe(false);
  });

  it("accepts exactly one hundred and nothing else", () => {
    expect(weightsAreValid([parameter("a", 60), parameter("b", 40)])).toBe(true);
    expect(weightsAreValid([parameter("a", 60), parameter("b", 30)])).toBe(false);
    expect(weightsAreValid([parameter("a", 60), parameter("b", 50)])).toBe(false);
    expect(weightsAreValid([])).toBe(false);
  });

  it("reports an invalid total on the result instead of refusing to score", () => {
    // The service refuses the save; the preview still has to show what the
    // half-finished configuration would produce.
    const result = scoreCohort(
      [parameter("sales", 30)],
      [member("a", { sales: 10 }), member("b", { sales: 0 })],
    );

    expect(result.weightsTotal).toBe(30);
    expect(result.weightsValid).toBe(false);
    expect(totals(result)).toEqual([30, 0]);
    expect(REQUIRED_WEIGHT_TOTAL).toBe(100);
  });
});
