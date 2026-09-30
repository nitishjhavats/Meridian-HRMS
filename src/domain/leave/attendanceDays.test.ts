import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { countLeaveDays } from "./index";
import {
  isHalfClaimed,
  leaveAttendanceDays,
  leaveAttendanceDaysForMissingRows,
} from "./attendanceDays";

/**
 * The bug these pin: approving leave moved a balance and told payroll nothing,
 * so the day fell through to `statusForMissingAttendance` and was paid as an
 * absence. The person lost the day twice.
 */

const FULL = {
  span: {
    startDate: "2026-09-14",
    endDate: "2026-09-16",
    startDayPart: "FULL",
    endDayPart: "FULL",
  },
  chargeableDates: ["2026-09-14", "2026-09-15", "2026-09-16"],
} as const;

describe("leaveAttendanceDays", () => {
  it("turns a paid leave into paid-leave days, which is the whole point", () => {
    const rows = leaveAttendanceDays({ ...FULL, paid: true });
    expect(rows.map((r) => r.status)).toEqual(["PAID_LEAVE", "PAID_LEAVE", "PAID_LEAVE"]);
    expect(rows.map((r) => r.date)).toEqual([...FULL.chargeableDates]);
  });

  it("marks an unpaid type as unpaid rather than as nothing", () => {
    const rows = leaveAttendanceDays({ ...FULL, paid: false });
    expect(rows.every((r) => r.status === "UNPAID_LEAVE")).toBe(true);
  });

  it("lets presence beat the claim — a day already worked is left alone", () => {
    const rows = leaveAttendanceDays({
      ...FULL,
      paid: true,
      workedDates: new Set(["2026-09-15"]),
    });
    expect(rows.map((r) => r.date)).toEqual(["2026-09-14", "2026-09-16"]);
  });

  it("writes nothing at all when every day was worked", () => {
    const rows = leaveAttendanceDays({
      ...FULL,
      paid: true,
      workedDates: new Set(FULL.chargeableDates),
    });
    expect(rows).toEqual([]);
  });

  it("never produces a day outside the chargeable list", () => {
    // A Sunday inside the span that countLeaveDays already skipped.
    const rows = leaveAttendanceDays({
      span: {
        startDate: "2026-09-12",
        endDate: "2026-09-15",
        startDayPart: "FULL",
        endDayPart: "FULL",
      },
      chargeableDates: ["2026-09-12", "2026-09-14", "2026-09-15"],
      paid: true,
    });
    expect(rows.map((r) => r.date)).not.toContain("2026-09-13");
  });
});

describe("half days — the four cases that get argued about", () => {
  const HALF_START = {
    span: {
      startDate: "2026-09-14",
      endDate: "2026-09-15",
      startDayPart: "SECOND_HALF",
      endDayPart: "FULL",
    },
    chargeableDates: ["2026-09-14", "2026-09-15"],
  } as const;

  it("half worked plus half paid leave is a whole day, not half of one", () => {
    const rows = leaveAttendanceDays({
      ...HALF_START,
      paid: true,
      workedDates: new Set(["2026-09-14"]),
    });
    expect(rows[0]).toMatchObject({ date: "2026-09-14", status: "FULL_DAY" });
  });

  it("half worked plus half unpaid leave is half a day", () => {
    const rows = leaveAttendanceDays({
      ...HALF_START,
      paid: false,
      workedDates: new Set(["2026-09-14"]),
    });
    expect(rows[0]).toMatchObject({ date: "2026-09-14", status: "HALF_DAY" });
  });

  it("half paid leave with nobody turning up is half a day", () => {
    const rows = leaveAttendanceDays({ ...HALF_START, paid: true });
    expect(rows[0]).toMatchObject({ date: "2026-09-14", status: "HALF_DAY" });
  });

  it("half unpaid leave with nobody turning up owes nothing", () => {
    const rows = leaveAttendanceDays({ ...HALF_START, paid: false });
    expect(rows[0]).toMatchObject({ date: "2026-09-14", status: "ABSENT" });
  });

  it("only the claimed end is half — the middle of a span is whole", () => {
    const rows = leaveAttendanceDays({
      span: {
        startDate: "2026-09-14",
        endDate: "2026-09-16",
        startDayPart: "SECOND_HALF",
        endDayPart: "FIRST_HALF",
      },
      chargeableDates: ["2026-09-14", "2026-09-15", "2026-09-16"],
      paid: true,
    });
    expect(rows.map((r) => r.status)).toEqual(["HALF_DAY", "PAID_LEAVE", "HALF_DAY"]);
  });
});

describe("isHalfClaimed agrees with countLeaveDays", () => {
  /**
   * The two have to agree or a day is billed as a whole in one place and a half
   * in the other. `countLeaveDays` only honours a half when that end of the
   * span is itself chargeable; so does this.
   */
  it("ignores a half-day marker on an end that fell on a week-off", () => {
    const span = {
      startDate: "2026-09-13", // a Sunday
      endDate: "2026-09-15",
      startDayPart: "SECOND_HALF",
      endDayPart: "FULL",
    } as const;
    const counted = countLeaveDays(span, {
      weekOffs: new Set(["2026-09-13"]),
      holidays: new Set(),
    });

    // countLeaveDays charged two whole days, not one and a half.
    expect(counted.totalDays).toBe(2);
    expect(
      counted.chargeableDates.some((d) =>
        isHalfClaimed(d, { span, chargeableDates: counted.chargeableDates }),
      ),
    ).toBe(false);
  });

  it("honours the half when that end is a working day", () => {
    const span = {
      startDate: "2026-09-14",
      endDate: "2026-09-15",
      startDayPart: "SECOND_HALF",
      endDayPart: "FULL",
    } as const;
    const counted = countLeaveDays(span);
    expect(counted.totalDays).toBe(1.5);

    const rows = leaveAttendanceDays({
      span,
      chargeableDates: counted.chargeableDates,
      paid: true,
    });
    expect(rows.map((r) => r.status)).toEqual(["HALF_DAY", "PAID_LEAVE"]);
  });
});

describe("the payroll read path", () => {
  it("assumes nothing was worked, because it only sees days with no row", () => {
    const rows = leaveAttendanceDaysForMissingRows({ ...FULL, paid: true });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "PAID_LEAVE")).toBe(true);
  });
});

/**
 * Source guards. Pinning the pure function above does not pin its callers, and
 * the callers are the whole fix — the function existing and nobody calling it
 * is exactly the state this round is cleaning up elsewhere.
 */
describe("both callers actually call it", () => {
  const read = (p: string) => readFileSync(path.resolve(p), "utf8");
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("decideLeave writes attendance days inside its transaction", () => {
    const code = strip(read("src/services/leave/index.ts"));
    expect(code).toMatch(/leaveAttendanceDays/);
    expect(code).toMatch(/attendanceDay\.(upsert|createMany|updateMany)/);
    // And removes them again when the request stops being approved.
    expect(code).toMatch(/attendanceDay\.deleteMany/);
    expect(code).toMatch(/leaveRequestId/);
  });

  it("buildPayrollInput reads approved leave before defaulting a day to absent", () => {
    const code = strip(read("src/services/payroll/inputBuilder.ts"));
    expect(code).toMatch(/leaveRequest\.findMany/);
    expect(code).toMatch(/leaveAttendanceDaysForMissingRows/);

    // The safety net must be consulted before the default, not after it.
    const netAt = code.indexOf("leaveAttendanceDaysForMissingRows");
    const defaultAt = code.indexOf("statusForMissingAttendance(day.kind)");
    expect(netAt).toBeGreaterThan(-1);
    expect(defaultAt).toBeGreaterThan(-1);
    expect(netAt).toBeLessThan(defaultAt);
  });

  it("evaluateDay no longer carries a second, unreachable copy of this decision", () => {
    const code = strip(read("src/domain/attendance/policy.ts"));
    // It took `leave: { paid, half }` and branched on it, and nothing ever
    // passed it. Two functions answering "what does leave make of this day" is
    // how a day gets paid twice.
    expect(code).not.toMatch(/input\.leave/);
    expect(code).not.toMatch(/leave\?:\s*\{\s*paid/);
  });
});

/**
 * The weekly rest day, booked as a request.
 *
 * "Request leave me week off v jod do aur har jagah se isko link karke sync kar
 * do payroll se v aur leave management se v."
 *
 * One marker does the linking. A day booked against a week-off type becomes
 * `WEEK_OFF` rather than `PAID_LEAVE`, and that single difference is the whole
 * connection: the payroll engine counts `weekOffDays`, the monthly quota is
 * measured against that count, and the rule that pays for rest days somebody
 * did not get to take reads the shortfall from it. Write `PAID_LEAVE` instead
 * and a booked rest day would be paid leave in payroll, spend a leave balance,
 * and never count towards the quota.
 */
describe("a week off booked as leave", () => {
  const SPAN = {
    span: {
      startDate: "2026-09-14",
      endDate: "2026-09-14",
      startDayPart: "FULL",
      endDayPart: "FULL",
    },
    chargeableDates: ["2026-09-14"],
  } as const;

  it("becomes a week off, not paid leave", () => {
    const rows = leaveAttendanceDays({ ...SPAN, paid: true, weekOff: true });
    expect(rows[0]).toMatchObject({ status: "WEEK_OFF", remark: "Weekly off" });
  });

  it("is a week off whether the type is paid or not", () => {
    // `weekOffPayable` in the payroll policy decides whether it is paid, not
    // the leave type — two answers to one question is how they disagree.
    const rows = leaveAttendanceDays({ ...SPAN, paid: false, weekOff: true });
    expect(rows[0]?.status).toBe("WEEK_OFF");
  });

  it("still loses to a day that was actually worked", () => {
    const rows = leaveAttendanceDays({
      ...SPAN,
      paid: true,
      weekOff: true,
      workedDates: new Set(["2026-09-14"]),
    });
    expect(rows).toEqual([]);
  });

  it("leaves every other type exactly as it was", () => {
    const rows = leaveAttendanceDays({ ...SPAN, paid: true });
    expect(rows[0]?.status).toBe("PAID_LEAVE");
  });

  it("reaches payroll through both callers", () => {
    const approval = readFileSync(path.resolve("src/services/leave/index.ts"), "utf8");
    const payroll = readFileSync(path.resolve("src/services/payroll/inputBuilder.ts"), "utf8");
    expect(approval).toMatch(/weekOff: request\.leaveType\.isWeekOff/);
    expect(payroll).toMatch(/weekOff: request\.leaveType\.isWeekOff/);
  });
});
