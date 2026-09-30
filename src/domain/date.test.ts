import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_TIME_ZONE, instantInZone, isValidTimeZone, todayInZone, zonedTimeToInstant } from "./date";

describe("zone conversion", () => {
  // The bug this guards: treating a 9 am shift as 09:00 UTC makes every Indian
  // check-in show up at 2:30 pm.
  it("turns a wall-clock time in a zone into the right instant", () => {
    const instant = zonedTimeToInstant("2026-03-15", 9 * 60, "Asia/Kolkata");
    expect(instant.toISOString()).toBe("2026-03-15T03:30:00.000Z");
  });

  it("round-trips through instantInZone", () => {
    for (const [date, minutes, zone] of [
      ["2026-03-15", 9 * 60, "Asia/Kolkata"],
      ["2026-12-31", 23 * 60 + 45, "Asia/Kolkata"],
      ["2026-01-01", 0, "Asia/Kolkata"],
      ["2026-07-04", 14 * 60 + 30, "America/New_York"],
      ["2026-11-20", 8 * 60, "Europe/London"],
    ] as const) {
      const back = instantInZone(zonedTimeToInstant(date, minutes, zone), zone);
      expect(`${zone} ${back.date} ${back.minutes}`).toBe(`${zone} ${date} ${minutes}`);
    }
  });

  // A zone that actually observes daylight saving, on both sides of the change.
  it("handles daylight saving on either side of the switch", () => {
    const winter = zonedTimeToInstant("2026-01-15", 12 * 60, "America/New_York");
    expect(winter.toISOString()).toBe("2026-01-15T17:00:00.000Z");

    const summer = zonedTimeToInstant("2026-07-15", 12 * 60, "America/New_York");
    expect(summer.toISOString()).toBe("2026-07-15T16:00:00.000Z");
  });

  it("keeps UTC unchanged", () => {
    expect(zonedTimeToInstant("2026-05-01", 6 * 60, "UTC").toISOString()).toBe(
      "2026-05-01T06:00:00.000Z",
    );
  });

  it("reports the calendar date in the zone, not in UTC", () => {
    // 23:30 IST on the 15th is still 18:00 UTC on the 15th…
    const evening = zonedTimeToInstant("2026-06-15", 23 * 60 + 30, "Asia/Kolkata");
    expect(evening.toISOString().slice(0, 10)).toBe("2026-06-15");
    // …but 00:30 IST on the 16th is 19:00 UTC on the 15th.
    const justAfterMidnight = zonedTimeToInstant("2026-06-16", 30, "Asia/Kolkata");
    expect(justAfterMidnight.toISOString().slice(0, 10)).toBe("2026-06-15");
    expect(instantInZone(justAfterMidnight, "Asia/Kolkata").date).toBe("2026-06-16");
  });

  it("resolves today in a zone", () => {
    const noonUtc = new Date("2026-06-15T20:00:00.000Z");
    // 20:00 UTC is already the 16th in Kolkata.
    expect(todayInZone("Asia/Kolkata", noonUtc)).toBe("2026-06-16");
    expect(todayInZone("UTC", noonUtc)).toBe("2026-06-15");
  });
});

describe("a bad timezone cannot take an organisation down", () => {
  /**
   * The zone was a free-text box with no check, and Intl throws RangeError on
   * a typo -- from the dashboard, from every attendance and payroll screen, for
   * every employee of that organisation.
   */
  it("knows a real zone from a typo", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkatta")).toBe(false);
    expect(isValidTimeZone("India")).toBe(false);
    expect(isValidTimeZone("GMT+5:30")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("falls back to India rather than throwing", () => {
    expect(FALLBACK_TIME_ZONE).toBe("Asia/Kolkata");
    const at = new Date("2026-09-12T20:00:00.000Z");
    expect(instantInZone(at, "Asia/Kolkatta")).toEqual(instantInZone(at, "Asia/Kolkata"));
    expect(todayInZone("nonsense", at)).toBe(todayInZone("Asia/Kolkata", at));
  });

  it("and the platform's organisation routes refuse an unknown zone", () => {
    for (const f of ["src/app/api/platform/organizations/route.ts", "src/app/api/platform/organizations/[id]/route.ts"]) {
      expect(readFileSync(path.resolve(f), "utf8"), f).toMatch(/\.refine\(isValidTimeZone/);
    }
  });
});
