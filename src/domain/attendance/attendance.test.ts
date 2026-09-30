import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_ACCURACY_METERS,
  MIN_ACCURACY_BUDGET_METERS,
  accuracyBudget,
  checkGeofence,
  describeDistance,
  distanceMeters,
  isPlausible,
} from "./geo";
import {
  DEFAULT_ATTENDANCE_POLICY,
  MIN_MINUTES_BEFORE_CHECKOUT,
  PRESENT_STATUSES,
  STATUS_LABELS,
  attendancePolicySchema,
  checkoutTooSoon,
  describeMarkingWindow,
  evaluateDay,
  isWithinMarkingWindow,
  markingWindow,
  mayMarkFromOwnDevice,
  safeParseAttendancePolicy,
  settleOpenDay,
  shiftDayFor,
  type AttendancePolicy,
  type AttendanceStatus,
} from "./policy";

const OFFICE = { latitude: 25.6093, longitude: 85.1235, radiusMeters: 100 };

function policyWith(patch: (p: AttendancePolicy) => void): AttendancePolicy {
  const copy = structuredClone(DEFAULT_ATTENDANCE_POLICY) as AttendancePolicy;
  patch(copy);
  return copy;
}

const at = (h: number, m = 0) => h * 60 + m;

// ------------------------------------------------------------------ geofence

describe("geofence", () => {
  it("accepts a check-in at the office", () => {
    const result = checkGeofence({ latitude: 25.6093, longitude: 85.1235, accuracyMeters: 12 }, OFFICE);
    expect(result.ok).toBe(true);
    expect(result.distanceMeters).toBe(0);
  });

  it("accepts a check-in just inside the 100 m radius", () => {
    // ~0.0007° of latitude ≈ 78 m
    const result = checkGeofence({ latitude: 25.6100, longitude: 85.1235, accuracyMeters: 10 }, OFFICE);
    expect(result.ok).toBe(true);
    expect(result.distanceMeters).toBeLessThan(100);
  });

  it("rejects a check-in outside the radius and says how far away it is", () => {
    const result = checkGeofence({ latitude: 25.6200, longitude: 85.1235, accuracyMeters: 10 }, OFFICE);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("OUTSIDE_RADIUS");
    expect(result.distanceMeters).toBeGreaterThan(1_000);
    expect(result.message).toContain("100 m");
  });

  // The accuracy gate is a switch an organisation may turn on. Off -- the
  // shipped state -- the distance alone decides: measured on a live
  // organisation, the people the gate turned away were at the counter with a
  // phone that cannot do better than ±50 m, and no refusal was ever recorded.
  it("does not consult the accuracy unless a ceiling is given", () => {
    const rough = { latitude: 25.6093, longitude: 85.1235, accuracyMeters: 5_000 };
    expect(checkGeofence(rough, OFFICE).ok).toBe(true);
    expect(checkGeofence(rough, OFFICE, { maxAccuracyMeters: null }).ok).toBe(true);
    // A ±250 m reading 80 m from the office passes on distance alone.
    const coarseButClose = { latitude: 25.6100, longitude: 85.1235, accuracyMeters: 250 };
    expect(checkGeofence(coarseButClose, OFFICE).ok).toBe(true);
    expect(checkGeofence(coarseButClose, OFFICE).distanceMeters).toBeLessThan(100);
  });

  it("ships with the gate off, and a stored policy from before the switch parses to off", () => {
    expect(DEFAULT_ATTENDANCE_POLICY.gpsAccuracy).toEqual({ enforce: false, maxMeters: 35 });
    const parsed = attendancePolicySchema.safeParse({});
    expect(parsed.success && parsed.data.gpsAccuracy).toEqual({ enforce: false, maxMeters: 35 });
  });

  it("rejects a reading whose accuracy is too poor to trust, when an accurate fix is demanded", () => {
    const result = checkGeofence(
      { latitude: 25.6093, longitude: 85.1235, accuracyMeters: 5_000 },
      OFFICE,
      { maxAccuracyMeters: accuracyBudget(OFFICE.radiusMeters) },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("ACCURACY_TOO_LOW");
  });

  it("rejects missing coordinates with a helpful message", () => {
    const result = checkGeofence(null, OFFICE);
    expect(result.reason).toBe("COORDINATES_MISSING");
    expect(result.message).toContain("enable GPS");
  });

  it("rejects Null Island and out-of-range coordinates", () => {
    expect(isPlausible({ latitude: 0, longitude: 0 })).toBe(false);
    expect(isPlausible({ latitude: 91, longitude: 20 })).toBe(false);
    expect(checkGeofence({ latitude: 0, longitude: 0 }, OFFICE).reason).toBe("IMPLAUSIBLE_COORDINATES");
  });

  it("does not let a wide accuracy circle become permission to be far away", () => {
    // ±250 m is a cell-tower estimate, not a fix. It is refused for what it
    // is, and no amount of slack rescues it -- which is the point: accuracy
    // used to gate entry at 3× the radius and then play no part at all in the
    // comparison, so a ±250 m reading landing 80 m out was trusted like a
    // surveyed one.
    const coords = { latitude: 25.6120, longitude: 85.1235, accuracyMeters: 250 };
    const demanded = { maxAccuracyMeters: accuracyBudget(OFFICE.radiusMeters) };
    expect(checkGeofence(coords, OFFICE, demanded).reason).toBe("ACCURACY_TOO_LOW");
    expect(checkGeofence(coords, OFFICE, { ...demanded, allowAccuracySlack: true }).reason).toBe(
      "ACCURACY_TOO_LOW",
    );
  });

  it("never widens the budget as the fence grows", () => {
    // The ceiling was once `radius × 3`, so moving every organisation to 150 m
    // would have quietly raised the tolerance from ±300 m to ±450 m. It is now
    // a *fraction* of the radius under a hard cap -- and the cap is the half
    // that matters: the fraction was loosened from a fifth to a third and the
    // ceiling did not move, so a wider fence still cannot buy weaker evidence.
    const wide = { latitude: 25.6093, longitude: 85.1235, radiusMeters: 150 };
    const sloppy = { latitude: 25.6093, longitude: 85.1235, accuracyMeters: 120 };
    const demanded = { maxAccuracyMeters: accuracyBudget(wide.radiusMeters) };
    expect(checkGeofence(sloppy, wide, demanded).reason).toBe("ACCURACY_TOO_LOW");
    expect(checkGeofence({ ...sloppy, accuracyMeters: 25 }, wide, demanded).ok).toBe(true);
  });

  it("refuses the reading that caused the bug report", () => {
    // Reported from production: standing well outside a fence, the screen said
    // 65 m. ±65 m is precisely what Android's fused provider returns from Wi-Fi
    // and cell, and under the old flat 75 m ceiling it passed — so an honest
    // measurement of an untrustworthy position decided the day.
    const wide = { latitude: 25.6093, longitude: 85.1235, radiusMeters: 150 };
    const network = { latitude: 25.6096, longitude: 85.1235, accuracyMeters: 65 };
    const demanded = { maxAccuracyMeters: accuracyBudget(wide.radiusMeters) };
    expect(checkGeofence(network, wide, demanded).reason).toBe("ACCURACY_TOO_LOW");
    // And no distance is offered for it. Printing a confident number over a
    // position this coarse is the whole defect.
    expect(checkGeofence(network, wide, demanded).distanceMeters).toBeNull();
  });

  it("scales the budget to a third of the fence, floored and capped", () => {
    expect(accuracyBudget(20)).toBe(MIN_ACCURACY_BUDGET_METERS);
    expect(accuracyBudget(100)).toBe(33);
    expect(accuracyBudget(150)).toBe(MAX_ACCURACY_METERS);
    expect(accuracyBudget(500)).toBe(MAX_ACCURACY_METERS);
    expect(accuracyBudget(5_000)).toBe(MAX_ACCURACY_METERS);
    // Monotonic and never above the cap, whatever the radius.
    for (let r = 20; r <= 5_000; r += 37) {
      const budget = accuracyBudget(r);
      expect(budget, String(r)).toBeLessThanOrEqual(MAX_ACCURACY_METERS);
      expect(budget, String(r)).toBeGreaterThanOrEqual(MIN_ACCURACY_BUDGET_METERS);
    }
  });

  it("still lets a trustworthy reading claim its own error circle when asked to", () => {
    // Slack is off in production; this pins what it means when it is on, so
    // the two behaviours cannot be confused for each other. The reading has to
    // be good enough to be trusted at all first — which is the change.
    // 0.001 degrees of latitude is about 111 m: outside the 100 m fence, but
    // inside 100 + 18 once the reading is allowed to claim its own circle.
    const coords = { latitude: 25.6103, longitude: 85.1235, accuracyMeters: 18 };
    expect(checkGeofence(coords, OFFICE).reason).toBe("OUTSIDE_RADIUS");
    expect(checkGeofence(coords, OFFICE, { allowAccuracySlack: true }).ok).toBe(true);
  });

  it("measures distance symmetrically", () => {
    const a = distanceMeters({ latitude: 25.6093, longitude: 85.1235 }, { ...OFFICE, latitude: 25.6193 });
    expect(a).toBeGreaterThan(1_000);
    expect(a).toBeLessThan(1_200);
  });
});

// ------------------------------------------------------------------ day evaluation

describe("day evaluation", () => {
  const workday = { dayKind: "WORKING" as const };

  // Spec §15 worked example: 9:00 shift, 10 min grace, 15 min late, 30 min half day.
  it("treats 9:05 as on time with a 10-minute grace", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9, 5), checkOutMinutes: at(18) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("FULL_DAY");
    expect(result.isLate).toBe(false);
    expect(result.lateMinutes).toBe(0);
  });

  it("marks 9:18 as late but still a full day", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9, 18), checkOutMinutes: at(18, 30) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.isLate).toBe(true);
    expect(result.lateMinutes).toBe(18);
    expect(result.status).toBe("FULL_DAY");
  });

  it("turns 9:35 into a half day once past the half-day threshold", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9, 35), checkOutMinutes: at(18, 30) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("HALF_DAY");
    expect(result.notes.some((n) => n.includes("half-day threshold"))).toBe(true);
  });

  // Spec §45 example 3 with the org's own thresholds.
  it("respects an organisation's own late thresholds", () => {
    const strict = policyWith((p) => {
      p.graceMinutes = 15;
      p.lateAfterMinutes = 20;
      p.halfDayAfterMinutes = 30;
    });
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9, 28), checkOutMinutes: at(18) },
      strict,
    );
    expect(result.isLate).toBe(true);
    expect(result.status).toBe("FULL_DAY");
  });

  it("marks a short day as a half day", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9), checkOutMinutes: at(14) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("HALF_DAY");
    expect(result.workedMinutes).toBe(240);
  });

  it("marks a very short day as absent", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9), checkOutMinutes: at(11) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("ABSENT");
  });

  it("records an early departure", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9), checkOutMinutes: at(16) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.earlyLeaveMinutes).toBe(120);
  });

  it("applies the configured treatment for a missing check-out", () => {
    const half = evaluateDay(
      { ...workday, checkInMinutes: at(9), checkOutMinutes: null },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(half.status).toBe("HALF_DAY");

    const absent = evaluateDay(
      { ...workday, checkInMinutes: at(9), checkOutMinutes: null },
      policyWith((p) => {
        p.missingCheckout = "ABSENT";
      }),
    );
    expect(absent.status).toBe("ABSENT");
  });

  it("marks a no-show as absent", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: null, checkOutMinutes: null },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("ABSENT");
  });

  // Spec §45 example 4.
  it("turns Sunday work into an extra day", () => {
    const result = evaluateDay(
      { dayKind: "WEEK_OFF", checkInMinutes: at(10), checkOutMinutes: at(18) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("EXTRA_DAY");
    expect(result.isExtraDay).toBe(true);
  });

  it("leaves an unworked week off alone", () => {
    const result = evaluateDay(
      { dayKind: "WEEK_OFF", checkInMinutes: null, checkOutMinutes: null },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("WEEK_OFF");
  });

  it("does not award an extra day for a token appearance", () => {
    const result = evaluateDay(
      { dayKind: "WEEK_OFF", checkInMinutes: at(10), checkOutMinutes: at(11) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("WEEK_OFF");
    expect(result.notes.some((n) => n.includes("extra-day threshold"))).toBe(true);
  });

  // Spec §45 example 5.
  it("turns holiday work into an extra day too", () => {
    const result = evaluateDay(
      { dayKind: "HOLIDAY", checkInMinutes: at(9), checkOutMinutes: at(18) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("EXTRA_DAY");
  });

  /**
   * This used to assert that `evaluateDay` turned an approved leave into
   * `PAID_LEAVE`. It passed for months while the branch was unreachable: the
   * only production caller runs on a check-in, and the branch required there to
   * be none. A green test over dead code is worse than no test, because it
   * reads as coverage of a path that production never takes.
   *
   * What an approved leave makes of a day now lives in
   * `src/domain/leave/attendanceDays.ts` and is tested there, against the two
   * callers that actually reach it.
   */
  it("has no opinion about leave — a day with no check-in is simply absent", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: null, checkOutMinutes: null },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("ABSENT");
  });

  it("marks a training day distinctly", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9), checkOutMinutes: at(18), training: true },
      DEFAULT_ATTENDANCE_POLICY,
    );
    expect(result.status).toBe("TRAINING_DAY");
  });

  it("computes overtime beyond the shift plus threshold", () => {
    const result = evaluateDay(
      { ...workday, checkInMinutes: at(9), checkOutMinutes: at(21) },
      DEFAULT_ATTENDANCE_POLICY,
    );
    // 12 h elapsed − 1 h break = 660 worked; shift is 480 → 180 over
    expect(result.workedMinutes).toBe(660);
    expect(result.overtimeMinutes).toBe(180);
  });

  it("caps overtime at the configured daily maximum", () => {
    const capped = policyWith((p) => {
      p.overtime.maxMinutesPerDay = 60;
    });
    const result = evaluateDay({ ...workday, checkInMinutes: at(9), checkOutMinutes: at(23) }, capped);
    expect(result.overtimeMinutes).toBe(60);
  });

  it("handles a shift that crosses midnight", () => {
    const night = policyWith((p) => {
      p.shift = { start: "22:00", end: "06:00", breakMinutes: 30, crossesMidnight: true };
      p.minMinutesFullDay = 420;
    });
    const result = evaluateDay({ ...workday, checkInMinutes: at(22), checkOutMinutes: at(6) }, night);
    expect(result.workedMinutes).toBe(450);
    expect(result.status).toBe("FULL_DAY");
  });
});

describe("describeDistance", () => {
  it("keeps short distances in metres", () => {
    expect(describeDistance(85)).toBe("85 m");
    expect(describeDistance(999)).toBe("999 m");
  });

  it("switches to kilometres, with a decimal only where it helps", () => {
    expect(describeDistance(1_500)).toBe("1.5 km");
    // The real reading that prompted this: 830281 m is another city, and
    // nobody works that out from six digits.
    expect(describeDistance(830_281)).toBe("830 km");
  });
});

describe("mayMarkFromOwnDevice", () => {
  const orgAllows = { marking: { self: true, kiosk: false } };
  const orgRefuses = { marking: { self: false, kiosk: true } };

  it("follows the organisation when the employee has no exception", () => {
    expect(mayMarkFromOwnDevice(orgAllows, { allowSelfMarking: null })).toBe(true);
    expect(mayMarkFromOwnDevice(orgRefuses, { allowSelfMarking: null })).toBe(false);
  });

  it("treats a missing field the same as null", () => {
    expect(mayMarkFromOwnDevice(orgRefuses, {})).toBe(false);
  });

  // The reason the exception exists: an organisation on office-device-only would
  // otherwise lock out every employee whose job is to be somewhere else.
  it("lets a field employee out of an office-device-only organisation", () => {
    expect(mayMarkFromOwnDevice(orgRefuses, { allowSelfMarking: true })).toBe(true);
  });

  it("can also pin one person to the office when the organisation is open", () => {
    expect(mayMarkFromOwnDevice(orgAllows, { allowSelfMarking: false })).toBe(false);
  });
});

describe("attendancePolicySchema", () => {
  const valid = () => structuredClone(DEFAULT_ATTENDANCE_POLICY) as AttendancePolicy;

  it("accepts the shipped default", () => {
    expect(safeParseAttendancePolicy(valid()).success).toBe(true);
  });

  // Every ATTENDANCE policy row written before this release predates `marking`
  // and `faceMatch`. Parsing must fill them in, not reject the organisation.
  it("fills in fields a stored policy predates", () => {
    const old = valid() as Partial<AttendancePolicy>;
    delete old.marking;
    delete old.extraDayMinMinutes;

    const parsed = safeParseAttendancePolicy(old);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.marking).toEqual({ self: true, kiosk: false });
      expect(parsed.data.extraDayMinMinutes).toBe(DEFAULT_ATTENDANCE_POLICY.extraDayMinMinutes);
    }
  });

  it("refuses a policy where nobody could mark attendance at all", () => {
    const policy = { ...valid(), marking: { self: false, kiosk: false } };
    const parsed = safeParseAttendancePolicy(policy);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join(".") === "marking")).toBe(true);
    }
  });

  it("refuses a grace period longer than the late threshold", () => {
    const policy = { ...valid(), graceMinutes: 30, lateAfterMinutes: 15 };
    expect(safeParseAttendancePolicy(policy).success).toBe(false);
  });

  it("refuses a late threshold past the half-day threshold", () => {
    const policy = { ...valid(), lateAfterMinutes: 45, halfDayAfterMinutes: 30 };
    expect(safeParseAttendancePolicy(policy).success).toBe(false);
  });

  it("refuses a half day needing more minutes than a full day", () => {
    const policy = { ...valid(), minMinutesHalfDay: 420, minMinutesFullDay: 420 };
    expect(safeParseAttendancePolicy(policy).success).toBe(false);
  });

  // The trap this module has warned about in a comment since it was written:
  // at or above the shift duration, every late arrival silently becomes a half
  // day and grace, late and half-day thresholds all stop meaning anything.
  it("refuses a full day that needs the whole shift", () => {
    // 09:00-18:00 with a 60-minute break is 480 nominal minutes.
    const policy = { ...valid(), minMinutesFullDay: 480 };
    const parsed = safeParseAttendancePolicy(policy);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.join(".") === "minMinutesFullDay")).toBe(true);
    }
  });

  it("accepts a full day just under the shift duration", () => {
    expect(safeParseAttendancePolicy({ ...valid(), minMinutesFullDay: 479 }).success).toBe(true);
  });

  it("refuses a shift time that is not a 24-hour clock", () => {
    const policy = valid();
    policy.shift.start = "9am";
    expect(safeParseAttendancePolicy(policy).success).toBe(false);
  });
});

/**
 * When attendance may be marked.
 *
 * The night-shift cases are the reason this is a function rather than two
 * subtractions at the call site: the old code compared a raw 0-1439 clock
 * against `start - open` and `end + close`, which for a 22:00-06:00 shift asks
 * for `minutes < 1200 || minutes > 600` — true at every minute of the day, so
 * every night-shift check-in was refused and the refusal quoted a range nobody
 * could satisfy.
 */
describe("markingWindow", () => {
  const at = (start: string, end: string, crossesMidnight = false) => ({
    shift: { start, end, breakMinutes: 60, crossesMidnight },
    checkInWindow: { openMinutesBeforeStart: 180, closeMinutesAfterEnd: 300 },
  });

  const m = (clock: string) => {
    const [h, mm] = clock.split(":").map(Number);
    return (h ?? 0) * 60 + (mm ?? 0);
  };

  it("opens three hours before the shift and closes five hours after it", () => {
    expect(describeMarkingWindow(at("09:00", "18:00"))).toEqual({
      opens: "06:00",
      closes: "23:00",
    });
  });

  it("accepts every minute inside the window and refuses the ones outside", () => {
    const policy = at("09:00", "18:00");
    for (const t of ["06:00", "08:59", "09:00", "13:00", "18:00", "22:59", "23:00"]) {
      expect(isWithinMarkingWindow(policy, m(t)), t).toBe(true);
    }
    for (const t of ["00:00", "05:59", "23:01", "23:59"]) {
      expect(isWithinMarkingWindow(policy, m(t)), t).toBe(false);
    }
  });

  it("lets an early shift open on the previous evening", () => {
    // 01:00 start, opening three hours early, is 22:00 yesterday — a negative
    // position on the extended axis, which the raw-clock version could not hold.
    const policy = at("01:00", "09:00");
    expect(markingWindow(policy).opensAt).toBe(-120);
    expect(describeMarkingWindow(policy).opens).toBe("22:00");
    expect(isWithinMarkingWindow(policy, m("22:30"))).toBe(true);
    expect(isWithinMarkingWindow(policy, m("21:30"))).toBe(false);
    expect(isWithinMarkingWindow(policy, m("02:00"))).toBe(true);
  });

  it("lets a late shift close after midnight", () => {
    const policy = at("14:00", "22:00");
    expect(markingWindow(policy).closesAt).toBe(1620);
    expect(describeMarkingWindow(policy).closes).toBe("03:00");
    expect(isWithinMarkingWindow(policy, m("02:30"))).toBe(true);
    expect(isWithinMarkingWindow(policy, m("03:30"))).toBe(false);
  });

  it("is satisfiable for a night shift, which it was not before", () => {
    const night = at("22:00", "06:00", true);
    expect(describeMarkingWindow(night)).toEqual({ opens: "19:00", closes: "11:00" });
    for (const t of ["19:00", "21:59", "22:00", "23:59", "00:00", "03:00", "06:00", "11:00"]) {
      expect(isWithinMarkingWindow(night, m(t)), t).toBe(true);
    }
    for (const t of ["11:01", "13:00", "18:59"]) {
      expect(isWithinMarkingWindow(night, m(t)), t).toBe(false);
    }
  });

  it("treats an end at or before the start as crossing midnight even unflagged", () => {
    // `shiftMinutes` already does this, and the window has to agree with it or
    // the day and the window would disagree about which shift is being worked.
    expect(describeMarkingWindow(at("22:00", "06:00", false))).toEqual(
      describeMarkingWindow(at("22:00", "06:00", true)),
    );
  });

  it("never refuses when the window is a full day wide", () => {
    const always = {
      shift: { start: "09:00", end: "18:00", breakMinutes: 60, crossesMidnight: false },
      checkInWindow: { openMinutesBeforeStart: 1440, closeMinutesAfterEnd: 1440 },
    };
    for (let minute = 0; minute < 1440; minute += 37) {
      expect(isWithinMarkingWindow(always, minute), String(minute)).toBe(true);
    }
  });

  it("refuses everything except the shift itself when the window is zero", () => {
    const tight = {
      shift: { start: "09:00", end: "18:00", breakMinutes: 60, crossesMidnight: false },
      checkInWindow: { openMinutesBeforeStart: 0, closeMinutesAfterEnd: 0 },
    };
    expect(isWithinMarkingWindow(tight, m("08:59"))).toBe(false);
    expect(isWithinMarkingWindow(tight, m("09:00"))).toBe(true);
    expect(isWithinMarkingWindow(tight, m("18:00"))).toBe(true);
    expect(isWithinMarkingWindow(tight, m("18:01"))).toBe(false);
  });
});

/**
 * The shipped fence, and everything that has to follow it.
 *
 * **Back at 150 m.** It was tightened to 100 m on the reasoning that a hundred
 * metres is a building and its car park while a hundred and fifty reaches the
 * far side of the road -- sound in the abstract, and wrong against the marks
 * people actually make. Real check-ins on the live instance land 8 to 65 m from
 * the office they were made at, with the far end of that range being somebody
 * on the pavement outside a building whose fence centre sits at the middle of
 * it. A 100 m fence turns those arrivals away, and a person standing at their
 * own office being told they are not there is a worse failure than a person two
 * doors down being told they are.
 *
 * These pin the numbers that must move with it, because the failure is silent:
 * a form carrying its own copy of the old number would go on offering it to
 * every new branch and nobody would see the two disagree.
 */
describe("a day still in progress", () => {
  const policy = DEFAULT_ATTENDANCE_POLICY;

  it("is CHECKED_IN after a check-in, not the missing-checkout verdict", () => {
    // Shipped rule is HALF_DAY for a missing check-out; scoring that at 09:05
    // is how every arrival read "half day" for the whole day.
    const open = evaluateDay({ dayKind: "WORKING", checkInMinutes: 545, checkOutMinutes: null, open: true }, policy);
    expect(open.status).toBe("CHECKED_IN");
    expect(open.workedMinutes).toBe(0);
    // Lateness is known at check-in and kept.
    const late = evaluateDay({ dayKind: "WORKING", checkInMinutes: 600, checkOutMinutes: null, open: true }, policy);
    expect(late.status).toBe("CHECKED_IN");
    expect(late.lateMinutes).toBe(60);
    expect(late.isLate).toBe(true);
  });

  it("closes to the missing-checkout rule once the day is no longer open", () => {
    const closed = evaluateDay({ dayKind: "WORKING", checkInMinutes: 545, checkOutMinutes: null }, policy);
    expect(closed.status).toBe("HALF_DAY");
    expect(closed.notes).toContain("No check-out recorded");
  });

  it("is CHECKED_IN on a rest day too, and closes to an extra day", () => {
    const open = evaluateDay({ dayKind: "WEEK_OFF", checkInMinutes: 545, checkOutMinutes: null, open: true }, policy);
    expect(open.status).toBe("CHECKED_IN");
    const closed = evaluateDay({ dayKind: "WEEK_OFF", checkInMinutes: 545, checkOutMinutes: null }, policy);
    expect(closed.status).toBe("EXTRA_DAY");
  });

  it("settles through each of the three rules and leaves every other status alone", () => {
    expect(settleOpenDay("CHECKED_IN", "HALF_DAY")).toBe("HALF_DAY");
    expect(settleOpenDay("CHECKED_IN", "ABSENT")).toBe("ABSENT");
    expect(settleOpenDay("CHECKED_IN", "IGNORE")).toBe("FULL_DAY");
    // A rest day settles the way the close scores it: an extra day, whatever
    // the working-day rule says.
    expect(settleOpenDay("CHECKED_IN", "ABSENT", "WEEK_OFF")).toBe("EXTRA_DAY");
    expect(settleOpenDay("CHECKED_IN", "HALF_DAY", "HOLIDAY")).toBe("EXTRA_DAY");
    expect(settleOpenDay("FULL_DAY", "ABSENT", "WEEK_OFF")).toBe("FULL_DAY");
    for (const status of Object.keys(STATUS_LABELS) as AttendanceStatus[]) {
      if (status === "CHECKED_IN") continue;
      expect(settleOpenDay(status, "ABSENT")).toBe(status);
    }
  });

  it("counts as present, and has a label", () => {
    expect(PRESENT_STATUSES).toContain("CHECKED_IN");
    expect(STATUS_LABELS.CHECKED_IN).toBe("Checked in");
  });
});

describe("the shift day a moment belongs to", () => {
  const night = {
    ...DEFAULT_ATTENDANCE_POLICY,
    shift: { ...DEFAULT_ATTENDANCE_POLICY.shift, start: "22:00", end: "06:00", crossesMidnight: true },
  };

  it("is the calendar day for a shift that ends on its own day", () => {
    expect(shiftDayFor(DEFAULT_ATTENDANCE_POLICY, { date: "2026-09-18", minutes: 60 })).toEqual({
      date: "2026-09-18",
      minutes: 60,
    });
  });

  it("puts an early-morning check-out on the night shift's own day, on the extended axis", () => {
    // 06:00 the next morning is minute 1800 of the shift day: the window
    // (06:00 + 300) is still open, so the moment belongs to yesterday.
    expect(shiftDayFor(night, { date: "2026-09-19", minutes: 6 * 60 })).toEqual({
      date: "2026-09-18",
      minutes: 1800,
    });
    // 01:00 likewise -- a late arrival, not a check-in for the 19th.
    expect(shiftDayFor(night, { date: "2026-09-19", minutes: 60 })).toEqual({ date: "2026-09-18", minutes: 1500 });
    // Once the window has closed (11:00), the moment is the next shift day's.
    expect(shiftDayFor(night, { date: "2026-09-19", minutes: 11 * 60 })).toEqual({ date: "2026-09-19", minutes: 660 });
    // And a 22:00 check-in is on its own date.
    expect(shiftDayFor(night, { date: "2026-09-18", minutes: 22 * 60 })).toEqual({ date: "2026-09-18", minutes: 1320 });
  });

  it("scores a night shift's worked minutes across midnight", () => {
    const day = evaluateDay({ dayKind: "WORKING", checkInMinutes: 1320, checkOutMinutes: 1800 }, night);
    expect(day.status).toBe("FULL_DAY");
    expect(day.workedMinutes).toBe(480 - 60);
  });
});

describe("a check-out on the heels of a check-in", () => {
  it("is refused under five minutes and believed from five", () => {
    // Measured: 10:10:53 in, 10:11:04 out, day scored ABSENT with 0 minutes.
    const at = new Date("2026-09-17T04:40:53.000Z");
    expect(checkoutTooSoon(at, new Date(at.getTime() + 11_000))).toEqual({ tooSoon: true, minutesSince: 0 });
    expect(checkoutTooSoon(at, new Date(at.getTime() + 4 * 60_000 + 59_000)).tooSoon).toBe(true);
    expect(checkoutTooSoon(at, new Date(at.getTime() + 5 * 60_000))).toEqual({ tooSoon: false, minutesSince: 5 });
    expect(MIN_MINUTES_BEFORE_CHECKOUT).toBe(5);
  });
});

describe("the shipped radius, and what follows it", () => {
  it("is 150 metres", () => {
    expect(DEFAULT_ATTENDANCE_POLICY.defaultRadiusMeters).toBe(150);
  });

  it("loosens the accuracy budget to a third, under an unchanged cap", () => {
    // The fraction moved from a fifth to a third; `MAX_ACCURACY_METERS` did
    // not. So the shipped fence sits *at* the ceiling rather than above it,
    // and every larger fence is held to the same 35 m -- which is the only
    // reason loosening the ratio is safe at all.
    expect(accuracyBudget(100)).toBe(33);
    expect(accuracyBudget(150)).toBe(MAX_ACCURACY_METERS);
  });

  it("accepts at 150 m the reading a 100 m fence refuses", () => {
    // ±34 m standing at the centre. Good enough to decide the shipped fence
    // and -- by a single metre -- not good enough for a 100 m one. The single
    // metre is the ratio doing its job: the tolerance is a property of the
    // fence being decided, never a flat number.
    const centre = { latitude: 28.6139, longitude: 77.209 };
    const reading = { ...centre, accuracyMeters: 34 };
    const demand = (r: number) => ({ maxAccuracyMeters: accuracyBudget(r) });
    expect(checkGeofence(reading, { ...centre, radiusMeters: 150 }, demand(150)).ok).toBe(true);
    expect(checkGeofence(reading, { ...centre, radiusMeters: 100 }, demand(100)).reason).toBe(
      "ACCURACY_TOO_LOW",
    );
  });

  it("the branch form reads the default rather than repeating it", () => {
    const code = readFileSync(
      path.resolve("src/app/(app)/settings/organisation/Structure.tsx"),
      "utf8",
    );
    expect(code).toMatch(/const DEFAULT_RADIUS = DEFAULT_ATTENDANCE_POLICY\.defaultRadiusMeters/);
    // Whichever way the default moves, the form must not carry its own copy.
    expect(code.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\|\| (100|150)\b/);
  });

  it("and so does the schema, so a row created outside the form matches", () => {
    const schema = readFileSync(path.resolve("prisma/schema.prisma"), "utf8");
    expect(schema).toMatch(/radiusMeters\s+Int\s+@default\(150\)/);
  });
});
