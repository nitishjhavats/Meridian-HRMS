import { describe, expect, it } from "vitest";
import { isReportingLineLive, liveReportingWhere, reportingToday } from "./window";

const IST = "Asia/Kolkata";
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("reportingToday", () => {
  it("uses the organisation's zone, not UTC", () => {
    // 20:00 UTC on the 7th is 01:30 IST on the 8th. The old code, comparing
    // against `new Date()` in UTC, called this the 7th -- so between midnight
    // and 05:30 IST every line ending "today" was already treated as ended.
    expect(reportingToday(IST, new Date("2026-09-07T20:00:00.000Z"))).toEqual(d("2026-09-08"));
    expect(reportingToday("UTC", new Date("2026-09-07T20:00:00.000Z"))).toEqual(d("2026-09-07"));
  });

  it("is midnight, matching how the dates are stored", () => {
    expect(reportingToday(IST, new Date("2026-09-08T13:45:12.000Z")).toISOString()).toBe(
      "2026-09-08T00:00:00.000Z",
    );
  });
});

describe("isReportingLineLive", () => {
  const now = new Date("2026-09-08T06:00:00.000Z");

  it("treats a line with no dates as live", () => {
    expect(isReportingLineLive({ startDate: null, endDate: null }, IST, now)).toBe(true);
  });

  it("keeps a line that ends today", () => {
    // Somebody's last day as a manager is a day they were the manager.
    expect(isReportingLineLive({ startDate: null, endDate: d("2026-09-08") }, IST, now)).toBe(true);
  });

  it("drops a line that ended yesterday", () => {
    expect(isReportingLineLive({ startDate: null, endDate: d("2026-09-07") }, IST, now)).toBe(false);
  });

  it("refuses a line that has not started yet", () => {
    // Nothing checked this before, so a line dated to start next month handed
    // over the team the moment it was written.
    expect(isReportingLineLive({ startDate: d("2026-10-01"), endDate: null }, IST, now)).toBe(false);
  });

  it("accepts a line starting today", () => {
    expect(isReportingLineLive({ startDate: d("2026-09-08"), endDate: null }, IST, now)).toBe(true);
  });

  it("accepts a closed window that contains today", () => {
    expect(
      isReportingLineLive({ startDate: d("2026-01-01"), endDate: d("2026-12-31") }, IST, now),
    ).toBe(true);
  });
});

describe("liveReportingWhere", () => {
  it("bounds both ends", () => {
    const where = liveReportingWhere(IST, new Date("2026-09-08T06:00:00.000Z"));
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].OR[1].startDate.lte).toEqual(d("2026-09-08"));
    expect(where.AND[1].OR[1].endDate.gte).toEqual(d("2026-09-08"));
  });

  it("agrees with the in-memory form", () => {
    const now = new Date("2026-09-08T06:00:00.000Z");
    const where = liveReportingWhere(IST, now);
    const boundary = where.AND[1].OR[1].endDate.gte;
    // A row ending exactly on the boundary satisfies `gte`, and the in-memory
    // check agrees. These two drifting apart is the bug this file exists for.
    expect(isReportingLineLive({ startDate: null, endDate: boundary }, IST, now)).toBe(true);
  });
});
