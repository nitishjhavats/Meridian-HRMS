import { describe, expect, it } from "vitest";
import { probationPeriod, tenureBetween } from "./terms";

describe("probationPeriod", () => {
  it("says whole months in months, because that is how a letter says it", () => {
    expect(probationPeriod(30)).toBe("one month");
    expect(probationPeriod(90)).toBe("3 months");
    expect(probationPeriod(180)).toBe("6 months");
  });

  it("says anything else in days", () => {
    expect(probationPeriod(45)).toBe("45 days");
    expect(probationPeriod(100)).toBe("100 days");
    expect(probationPeriod(1)).toBe("one day");
  });

  it("returns null when there is no probation, rather than inventing a clause", () => {
    // The whole point. A signed appointment letter reading "a probation period
    // of 0 days" is a false term; a null leaves the placeholder unresolved and
    // `issueLetter` refuses, which tells somebody their template still carries
    // a clause their organisation does not use.
    expect(probationPeriod(0)).toBeNull();
    expect(probationPeriod(null)).toBeNull();
    expect(probationPeriod(-30)).toBeNull();
  });

  it("does not fall over on a value that is not a number", () => {
    expect(probationPeriod(Number.NaN)).toBeNull();
    expect(probationPeriod(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("tenureBetween", () => {
  it("counts whole years and months the way a person says them", () => {
    expect(tenureBetween("2023-04-13", "2026-07-13")).toBe("3 years and 3 months");
    expect(tenureBetween("2024-01-01", "2025-01-01")).toBe("1 year");
    expect(tenureBetween("2024-01-01", "2024-04-01")).toBe("3 months");
  });

  it("borrows a month when the day of the month has not come round", () => {
    // Joined on the 20th, left on the 5th: that is not two whole months.
    expect(tenureBetween("2024-01-20", "2024-03-05")).toBe("1 month");
    expect(tenureBetween("2023-06-15", "2025-06-14")).toBe("1 year and 11 months");
  });

  it("says less than a month rather than zero", () => {
    // "0 months" on an experience certificate reads like a mistake.
    expect(tenureBetween("2026-01-01", "2026-01-20")).toBe("less than a month");
    expect(tenureBetween("2026-01-01", "2026-01-01")).toBe("less than a month");
  });

  it("refuses a period that runs backwards rather than inventing one", () => {
    expect(tenureBetween("2026-05-01", "2024-01-01")).toBeNull();
    expect(tenureBetween("", "2026-01-01")).toBeNull();
  });
});
