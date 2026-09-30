import { describe, expect, it } from "vitest";

import {
  DAY_CLOSE_EPOCH,
  DAY_CLOSE_LOOKBACK_DAYS,
  closableDates,
  isDateClosed,
  isOnRoll,
  settleOpenRow,
  windowClosedAt,
} from "./dayClose";
import { DEFAULT_ATTENDANCE_POLICY } from "./policy";

const IST = "Asia/Kolkata";
const dayShift = DEFAULT_ATTENDANCE_POLICY; // 09:00-18:00, closes 300 min after the end
const nightShift = {
  ...DEFAULT_ATTENDANCE_POLICY,
  shift: { ...DEFAULT_ATTENDANCE_POLICY.shift, start: "22:00", end: "06:00", crossesMidnight: true },
};

describe("which dates a run may close", () => {
  it("looks back seven days (today and the seven before it) and never past today", () => {
    expect(DAY_CLOSE_LOOKBACK_DAYS).toBe(7);
    const dates = closableDates({ today: "2026-10-18" });
    expect(dates[0]).toBe("2026-10-11");
    expect(dates[dates.length - 1]).toBe("2026-10-18");
    expect(dates).toHaveLength(8);
  });

  it("never reaches before the epoch on its own: the owner chose no back-fill", () => {
    expect(DAY_CLOSE_EPOCH).toBe("2026-09-18");
    // The first night after the deploy closes the deploy day and nothing before it.
    expect(closableDates({ today: "2026-09-19" })).toEqual(["2026-09-18", "2026-09-19"]);
    expect(closableDates({ today: "2026-09-17" })).toEqual([]);
  });

  it("starts at `from` when that is later than the lookback, and is empty past today", () => {
    expect(closableDates({ today: "2026-10-18", from: "2026-10-16" })).toEqual([
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    // An explicit `from` may reach before the epoch -- that is the operator's
    // back-fill, asked for by name -- but not beyond the lookback given.
    expect(closableDates({ today: "2026-09-18", from: "2026-09-01" })[0]).toBe("2026-09-11");
    expect(closableDates({ today: "2026-09-18", from: "2026-09-01", lookbackDays: 30 })[0]).toBe(
      "2026-09-01",
    );
    expect(closableDates({ today: "2026-10-18", from: "2026-10-19" })).toEqual([]);
  });
});

describe("when a date is closed", () => {
  it("is once shift end plus the close window has passed in the organisation's zone", () => {
    // 18:00 + 300 min = 23:00 IST = 17:30 UTC.
    const closesAt = windowClosedAt("2026-09-17", dayShift, IST);
    expect(closesAt.toISOString()).toBe("2026-09-17T17:30:00.000Z");
    expect(isDateClosed("2026-09-17", dayShift, IST, new Date("2026-09-17T17:29:59.000Z"))).toBe(false);
    expect(isDateClosed("2026-09-17", dayShift, IST, new Date("2026-09-17T17:30:00.000Z"))).toBe(true);
  });

  it("follows a night shift onto the next morning", () => {
    // 22:00-06:00: the window closes 06:00 + 5 h = 11:00 IST the *next* day.
    const closesAt = windowClosedAt("2026-09-17", nightShift, IST);
    expect(closesAt.toISOString()).toBe("2026-09-18T05:30:00.000Z");
    // The nightly run at 03:00 UTC (08:30 IST) must not close it yet.
    expect(isDateClosed("2026-09-17", nightShift, IST, new Date("2026-09-18T03:00:00.000Z"))).toBe(false);
  });
});

describe("who was on the roll", () => {
  const person = { joiningDate: "2026-09-10", exitDate: "2026-09-20" };
  it("is from the joining date to the exit date, both inclusive", () => {
    expect(isOnRoll(person, "2026-09-09")).toBe(false);
    expect(isOnRoll(person, "2026-09-10")).toBe(true);
    expect(isOnRoll(person, "2026-09-20")).toBe(true);
    expect(isOnRoll(person, "2026-09-21")).toBe(false);
    expect(isOnRoll({ ...person, exitDate: null }, "2027-01-01")).toBe(true);
  });
});

describe("what an open row settles to", () => {
  const row = { dayKind: "WORKING" as const, checkInMinutes: 9 * 60 + 5, training: false };

  it("is the missing-checkout rule, whichever the organisation chose", () => {
    expect(settleOpenRow(row, { ...dayShift, missingCheckout: "HALF_DAY" }).status).toBe("HALF_DAY");
    expect(settleOpenRow(row, { ...dayShift, missingCheckout: "ABSENT" }).status).toBe("ABSENT");
    expect(settleOpenRow(row, { ...dayShift, missingCheckout: "IGNORE" }).status).toBe("FULL_DAY");
    expect(settleOpenRow(row, dayShift).notes).toContain("No check-out recorded");
  });

  it("keeps the lateness the check-in already showed", () => {
    const late = settleOpenRow({ ...row, checkInMinutes: 10 * 60 }, dayShift);
    expect(late.lateMinutes).toBe(60);
    expect(late.isLate).toBe(true);
  });

  it("is an extra day on a rest day", () => {
    expect(settleOpenRow({ ...row, dayKind: "WEEK_OFF" }, dayShift).status).toBe("EXTRA_DAY");
  });
});
