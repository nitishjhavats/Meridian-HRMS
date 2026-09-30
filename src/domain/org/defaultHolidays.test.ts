import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_ON_KEYS,
  defaultOnHolidays,
  holidayCatalogue,
  isDefaultOnHoliday,
} from "./holidayCatalogue";

/**
 * "Bas ye by default ye 3 on rahenge … aur ye har saal ayega."
 *
 * Three properties that have to hold together, and round 7 got the middle one
 * wrong by making the days un-switchable:
 *
 *   1. they arrive **on** — a calendar that starts empty calls 26 January a
 *      working day, and nobody notices until somebody is marked absent on it;
 *   2. they can be switched **off** — a plant running a shift on Republic Day is
 *      a real thing, and a product that refuses to describe it is wrong about
 *      the world rather than careful;
 *   3. they come back **every year**, without anybody remembering in January.
 *
 * 2 and 3 only coexist because of `Organization.holidaysSeededThrough`: the job
 * seeds a year once and records that it did, so it never revisits one — and a
 * holiday somebody deleted stays deleted.
 */

describe("the three that arrive on", () => {
  it("is exactly the three national days", () => {
    expect([...DEFAULT_ON_KEYS].sort()).toEqual([
      "gandhi-jayanti",
      "independence-day",
      "republic-day",
    ]);
  });

  it("falls on the same dates every year", () => {
    expect(defaultOnHolidays(2027).map((h) => h.date)).toEqual([
      "2027-01-26",
      "2027-08-15",
      "2027-10-02",
    ]);
  });

  it("keeps working past the years the festivals were researched for", () => {
    // The festival table stops at 2030 on purpose — a guessed lunar date marks
    // somebody absent on a day the office was shut. These three need no table,
    // which is what lets the yearly job run for ever.
    expect(defaultOnHolidays(2041)).toHaveLength(3);
    expect(holidayCatalogue(2041)).toHaveLength(3);
  });

  it("returns nothing for a year that is not one", () => {
    expect(defaultOnHolidays(1999)).toEqual([]);
    expect(defaultOnHolidays(2101)).toEqual([]);
    expect(defaultOnHolidays(Number.NaN)).toEqual([]);
  });

  it("marks them on-by-default in the catalogue, and the festivals not", () => {
    const catalogue = holidayCatalogue(2026);
    expect([...catalogue.filter((h) => h.defaultOn).map((h) => h.key)].sort()).toEqual([
      "gandhi-jayanti",
      "independence-day",
      "republic-day",
    ]);
    expect(catalogue.find((h) => h.key === "diwali")?.defaultOn).toBe(false);
  });

  it("recognises them by key, not by name", () => {
    expect(isDefaultOnHoliday("republic-day")).toBe(true);
    expect(isDefaultOnHoliday("diwali")).toBe(false);
    expect(isDefaultOnHoliday("Republic Day")).toBe(false);
  });

  it("never marks a lunar date as not needing a check", () => {
    expect(holidayCatalogue(2026).find((h) => h.key === "diwali")?.verify).toBe(true);
    expect(defaultOnHolidays(2026).every((h) => h.verify === false)).toBe(true);
  });
});

const read = (p: string) => readFileSync(path.resolve(p), "utf8");
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("off is a real answer again", () => {
  /**
   * Round 7 refused to switch one off, in two places. Both refusals are gone,
   * and these assert their absence rather than their presence — the failure
   * being guarded against is somebody reinstating them.
   */
  it("the catalogue toggle no longer refuses", () => {
    const code = strip(read("src/services/org/holidayCatalogue.ts"));
    expect(code).not.toMatch(/isMandatoryHoliday/);
    expect(code).not.toMatch(/stays on the calendar/);
  });

  it("deleteHoliday no longer refuses", () => {
    const code = strip(read("src/services/org/calendar.ts"));
    expect(code).not.toMatch(/mandatoryHolidays/);
    // The one guard that does belong there is still in place: a month whose
    // payroll has been approved must not have its working days changed.
    expect(code).toMatch(/assertPayrollOpen\(ctx\.organizationId!, date, "Removing a holiday from"\)/);
  });

  it("the switch is drawn on and enabled", () => {
    const code = strip(read("src/app/(app)/settings/calendar/SuggestedHolidays.tsx"));
    expect(code).toMatch(/checked=\{row\.added\}/);
    expect(code).not.toMatch(/row\.mandatory/);
    // Still says where the row came from, which is the honest half of round 7.
    expect(code).toMatch(/On by default/);
  });
});

describe("and they come back every year", () => {
  it("provisioning seeds two years and records how far it got", () => {
    const code = strip(read("src/services/platform/organizations.ts"));
    expect(code).toMatch(/defaultOnHolidays\(seedYear\)/);
    expect(code).toMatch(/defaultOnHolidays\(seedYear \+ 1\)/);
    expect(code).toMatch(/holidaysSeededThrough: seedYear \+ 1/);
  });

  it("the maintenance job seeds forward and never revisits a year", () => {
    const code = strip(read("src/services/org/yearlyHolidays.ts"));
    // Only organisations behind the mark are touched…
    expect(code).toMatch(/holidaysSeededThrough: \{ lt: throughYear \}/);
    // …and the mark moves, which is what makes a deleted holiday stay deleted.
    expect(code).toMatch(/data: \{ holidaysSeededThrough: throughYear \}/);
    // It adds and never corrects: an administrator who made one unpaid keeps it.
    expect(code).toMatch(/skipDuplicates: true/);
    expect(code).not.toMatch(/holiday\.(update|updateMany|delete|deleteMany)\(/);
  });

  it("an organisation predating the column starts at this year, not at 1970", () => {
    // Filling 2019 would put holidays into months whose payroll closed years ago.
    const code = strip(read("src/services/org/yearlyHolidays.ts"));
    expect(code).toMatch(/org\.holidaysSeededThrough \?\? now\.getUTCFullYear\(\)/);
  });

  it("the job actually runs it", () => {
    const code = strip(read("src/lib/jobs.ts"));
    expect(code).toMatch(/seedYearlyHolidays\(\)/);
    // And reports it, because a maintenance job silently doing nothing goes
    // unnoticed longest.
    expect(code).toMatch(/holidays,/);
  });
});
