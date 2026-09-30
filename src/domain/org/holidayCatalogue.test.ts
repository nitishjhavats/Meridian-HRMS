import { describe, expect, it } from "vitest";
import { CATALOGUE_YEARS, hasFestivalDates, holidayCatalogue } from "./holidayCatalogue";

describe("holidayCatalogue", () => {
  it("offers the three national days in every year", () => {
    for (const year of [2026, 2030, 2045]) {
      const keys = holidayCatalogue(year).map((h) => h.key);
      expect(keys, String(year)).toContain("republic-day");
      expect(keys, String(year)).toContain("independence-day");
      expect(keys, String(year)).toContain("gandhi-jayanti");
    }
  });

  it("puts the national days on the same date every year", () => {
    // Computed rather than listed, so the one thing this file can be certain
    // about does not run out in 2030.
    for (const year of [2026, 2031, 2099]) {
      const byKey = new Map(holidayCatalogue(year).map((h) => [h.key, h.date]));
      expect(byKey.get("republic-day")).toBe(`${year}-01-26`);
      expect(byKey.get("independence-day")).toBe(`${year}-08-15`);
      expect(byKey.get("gandhi-jayanti")).toBe(`${year}-10-02`);
    }
  });

  it("never asks for a national day to be checked", () => {
    for (const holiday of holidayCatalogue(2027)) {
      if (holiday.key.includes("day") || holiday.key === "gandhi-jayanti") {
        expect(holiday.verify, holiday.key).toBe(false);
      }
    }
  });

  it("marks every lunar festival for checking", () => {
    // They follow the lunar calendar and a regional calendar can differ by a
    // day, so the product asks rather than deciding somebody was absent.
    for (const year of CATALOGUE_YEARS) {
      const festivals = holidayCatalogue(year).filter((h) =>
        ["holi", "dussehra", "diwali"].includes(h.key),
      );
      expect(festivals.length, String(year)).toBe(3);
      for (const f of festivals) expect(f.verify, `${year} ${f.key}`).toBe(true);
    }
  });

  it("gives every festival a date inside its own year", () => {
    // The kind of typo that would otherwise sit in a table unread until it made
    // somebody absent on a public holiday.
    for (const year of CATALOGUE_YEARS) {
      for (const holiday of holidayCatalogue(year)) {
        expect(holiday.date.slice(0, 4), `${year} ${holiday.key}`).toBe(String(year));
      }
    }
  });

  it("gives every entry a real calendar date", () => {
    for (const year of CATALOGUE_YEARS) {
      for (const holiday of holidayCatalogue(year)) {
        expect(holiday.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        const parsed = new Date(`${holiday.date}T00:00:00Z`);
        expect(Number.isNaN(parsed.getTime()), holiday.date).toBe(false);
        // Round-trips, so 2027-02-30 cannot hide as 2027-03-02.
        expect(parsed.toISOString().slice(0, 10)).toBe(holiday.date);
      }
    }
  });

  it("returns them in date order", () => {
    for (const year of CATALOGUE_YEARS) {
      const dates = holidayCatalogue(year).map((h) => h.date);
      expect([...dates].sort()).toEqual(dates);
    }
  });

  it("uses one key per festival across the years, so a row can be matched back", () => {
    const first = holidayCatalogue(2026).map((h) => h.key).sort();
    for (const year of CATALOGUE_YEARS) {
      expect(holidayCatalogue(year).map((h) => h.key).sort(), String(year)).toEqual(first);
    }
  });

  it("offers no festivals for a year nobody researched, rather than guessing", () => {
    expect(hasFestivalDates(2031)).toBe(false);
    expect(holidayCatalogue(2031)).toHaveLength(3);
    for (const year of CATALOGUE_YEARS) expect(hasFestivalDates(year), String(year)).toBe(true);
  });

  it("refuses a year that is not one", () => {
    for (const year of [0, 1900, 2200, 2026.5, Number.NaN]) {
      expect(holidayCatalogue(year), String(year)).toEqual([]);
    }
  });
});
