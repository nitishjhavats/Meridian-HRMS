import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The monthly cap is fed, not merely defined.
 *
 * `validateLeave` refuses a request that would put more of a type into a
 * calendar month than `LeaveType.maxPerMonth` allows — but only if the service
 * hands it the cap and what is already booked in that month. The arithmetic is
 * unit-tested in `src/domain/leave`; what cannot be tested there is that
 * `evaluateRequest` fetches the right rows (this type, this person, pending
 * as well as approved, touching the months the request touches) and clips
 * them to the month before counting. These read the source for that wiring,
 * comments stripped, so a rule quoted in prose cannot pass for a rule in code.
 */

const read = (file: string) =>
  readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const LEAVE = read("src/services/leave/index.ts");
const TYPES = read("src/services/leave/types.ts");
const ROUTE = read("src/app/api/settings/leave-types/route.ts");
const SCREEN = read("src/app/(app)/settings/leave-types/LeaveTypes.tsx");
const FORM = read("src/app/(app)/me/leave/RequestLeave.tsx");
const PROVISION = read("src/services/platform/organizations.ts");

function bodyOf(source: string, name: string): string {
  const start = source.indexOf(name);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n}\n", start));
}

describe("evaluateRequest feeds the cap", () => {
  const body = bodyOf(LEAVE, "async function evaluateRequest(");

  it("fetches this type's pending and approved requests over the months the span touches", () => {
    expect(body).toMatch(/leaveTypeId: type\.id,\s*status: \{ in: \["PENDING", "APPROVED"\] \}/);
    expect(body).toMatch(/endDate: \{ gte: toDate\(monthsStart\) \}/);
    expect(body).toMatch(/startDate: \{ lte: toDate\(monthsEnd\) \}/);
  });

  it("and only when there is a cap to hold them to", () => {
    expect(body).toMatch(/type\.maxPerMonth === null\s*\?\s*Promise\.resolve\(\[\]\)/);
  });

  it("leaves out the request being re-priced", () => {
    expect(body).toMatch(/id: \{ not: options\.excludeRequestId \}/);
  });

  it("counts the calendar over whole months, so booked rows are clipped against the same rest days", () => {
    expect(body).toMatch(/nonWorkingDays\(organizationId, employeeId, monthsStart, monthsEnd\)/);
  });

  it("clips booked rows to the month through the domain rather than summing totalDays", () => {
    expect(body).toMatch(/taken: bookedDaysByMonth\(/);
    expect(body).toMatch(/startDayPart: r\.startDayPart,\s*endDayPart: r\.endDayPart/);
    expect(body).not.toMatch(/_sum: \{ totalDays: true \}/);
  });

  it("hands the cap to validateLeave", () => {
    expect(body).toMatch(/cap: type\.maxPerMonth/);
    expect(body).toMatch(/monthly,\s*\}\);/);
  });

  it("tells the form what is left in the month the request starts in", () => {
    expect(body).toMatch(/isWeekOff: type\.isWeekOff/);
    expect(body).toMatch(/left: Math\.max\(0, monthly\.cap - takenThisMonth\)/);
  });
});

describe("the type carries the marker and the cap", () => {
  it("the service writes both", () => {
    const body = bodyOf(TYPES, "export async function saveLeaveType(");
    expect(body).toMatch(/isWeekOff: input\.isWeekOff/);
    expect(body).toMatch(/maxPerMonth: input\.maxPerMonth/);
    expect(body).toMatch(/await assertOnlyWeekOff\(ctx\.organizationId!, input\)/);
  });

  it("and refuses a second on-demand week off, naming the one that holds it", () => {
    const body = bodyOf(TYPES, "async function assertOnlyWeekOff(");
    expect(body).toMatch(/isWeekOff: true/);
    expect(body).toMatch(/id: \{ not: input\.id \}/);
    expect(body).toMatch(/is already the on-demand week off/);
  });

  it("the route accepts both and neither can be silently defaulted away", () => {
    expect(ROUTE).toMatch(/isWeekOff: z\.boolean\(\),/);
    expect(ROUTE).toMatch(/maxPerMonth: z\.number\(\)\.int\(\)\.min\(1\)\.max\(31\)\.nullable\(\),/);
  });

  it("the screen offers the switch, the cap, and the tag", () => {
    expect(SCREEN).toMatch(/This is the on-demand week off/);
    expect(SCREEN).toMatch(/disabled=\{Boolean\(otherWeekOff\)\}/);
    expect(SCREEN).toMatch(/label="Max a month"/);
    expect(SCREEN).toMatch(/onValueChange=\{\(v\) => edit\("maxPerMonth", v\)\}/);
    expect(SCREEN).toMatch(/" · on-demand week off"/);
    expect(SCREEN).not.toMatch(/weekly rest day/);
  });

  it("the request form says rest days are free and what the month has left", () => {
    expect(FORM).toMatch(/preview\.type\.isWeekOff \?/);
    expect(FORM).toMatch(/never charged to this/);
    expect(FORM).toMatch(/preview\.monthly\.left\} left in \$\{preview\.monthly\.label\}/);
  });

  it("a new organisation is seeded with the type named and capped", () => {
    expect(PROVISION).toMatch(
      /code: "WEEK_OFF", name: "On-demand Week Off", .*monthlyAccrual: 4, maxPerMonth: 4, isWeekOff: true/,
    );
  });
});
