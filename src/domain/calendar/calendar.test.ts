import { describe, expect, it } from "vitest";
import { eachDay } from "../date";
import {
  type CalendarSubject,
  type HolidayEntry,
  type WeeklyOffConfig,
  buildPeriodCalendar,
  describeWeeklyOff,
  isWeeklyOff,
  validateWeeklyOffConfig,
} from "./index";

// April 2026 — Wed 1st. Sundays: 5, 12, 19, 26. Saturdays: 4, 11, 18, 25.
const APRIL = { start: "2026-04-01", end: "2026-04-30" };

function subject(weeklyOff: WeeklyOffConfig): CalendarSubject {
  return { employeeId: "emp_1", departmentId: "dept_1", region: "BR", weeklyOff };
}

describe("weekly off patterns", () => {
  it("FIXED marks one weekday every week", () => {
    const config: WeeklyOffConfig = { type: "FIXED", days: [0] };
    const offDays = eachDay(APRIL.start, APRIL.end).filter((d) => isWeeklyOff(d, config));
    expect(offDays).toEqual(["2026-04-05", "2026-04-12", "2026-04-19", "2026-04-26"]);
  });

  it("MULTIPLE marks Saturday and Sunday", () => {
    const config: WeeklyOffConfig = { type: "MULTIPLE", days: [0, 6] };
    const offDays = eachDay(APRIL.start, APRIL.end).filter((d) => isWeeklyOff(d, config));
    expect(offDays).toHaveLength(8);
    expect(offDays).toContain("2026-04-04");
    expect(offDays).toContain("2026-04-05");
  });

  // The pattern Indian organisations actually ask for.
  it("ROTATIONAL marks every Sunday plus the 2nd and 4th Saturday", () => {
    const config: WeeklyOffConfig = {
      type: "ROTATIONAL",
      days: [0],
      rotating: [{ day: 6, weeks: [2, 4] }],
    };
    const offDays = eachDay(APRIL.start, APRIL.end).filter((d) => isWeeklyOff(d, config));
    expect(offDays).toContain("2026-04-11"); // 2nd Saturday
    expect(offDays).toContain("2026-04-25"); // 4th Saturday
    expect(offDays).not.toContain("2026-04-04"); // 1st Saturday
    expect(offDays).not.toContain("2026-04-18"); // 3rd Saturday
    expect(offDays).toHaveLength(6);
  });

  it("ROTATIONAL supports alternate weeks by ISO parity", () => {
    const config: WeeklyOffConfig = {
      type: "ROTATIONAL",
      days: [0],
      rotating: [{ day: 6, isoParity: "EVEN" }],
    };
    const saturdays = eachDay(APRIL.start, APRIL.end)
      .filter((d) => isWeeklyOff(d, config))
      .filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 6);
    expect(saturdays.length).toBeGreaterThan(0);
    expect(saturdays.length).toBeLessThan(5);
  });

  it("CUSTOM uses an explicit date list", () => {
    const config: WeeklyOffConfig = { type: "CUSTOM", dates: ["2026-04-07", "2026-04-21"] };
    const offDays = eachDay(APRIL.start, APRIL.end).filter((d) => isWeeklyOff(d, config));
    expect(offDays).toEqual(["2026-04-07", "2026-04-21"]);
  });

  it("describes each pattern for the settings screen", () => {
    expect(describeWeeklyOff({ type: "FIXED", days: [0] })).toBe("Sunday");
    expect(describeWeeklyOff({ type: "MULTIPLE", days: [0, 6] })).toBe("Sunday, Saturday");
    expect(
      describeWeeklyOff({ type: "ROTATIONAL", days: [0], rotating: [{ day: 6, weeks: [2, 4] }] }),
    ).toBe("Sunday, 2nd & 4th Saturday");
  });

  it("rejects an invalid configuration", () => {
    expect(validateWeeklyOffConfig({ type: "FIXED", days: [9] })).toHaveLength(1);
    expect(validateWeeklyOffConfig({ type: "ROTATIONAL", days: [0] })).toHaveLength(1);
    expect(validateWeeklyOffConfig({ type: "CUSTOM", dates: [] })).toHaveLength(1);
    expect(validateWeeklyOffConfig({ type: "FIXED", days: [0] })).toHaveLength(0);
  });
});

describe("period calendar", () => {
  const sundayOff: WeeklyOffConfig = { type: "FIXED", days: [0] };

  it("counts working days, week offs and holidays", () => {
    const holidays: HolidayEntry[] = [
      { id: "h1", name: "Ram Navami", date: "2026-04-15", paid: true, optional: false },
    ];
    const cal = buildPeriodCalendar(APRIL.start, APRIL.end, subject(sundayOff), holidays);
    expect(cal.totalDays).toBe(30);
    expect(cal.weekOffDays).toBe(4);
    expect(cal.holidayDays).toBe(1);
    expect(cal.paidHolidayDays).toBe(1);
    expect(cal.workingDays).toBe(25);
  });

  it("does not double-count a holiday that falls on a week off", () => {
    const holidays: HolidayEntry[] = [
      { id: "h1", name: "Sunday holiday", date: "2026-04-12", paid: true, optional: false },
    ];
    const cal = buildPeriodCalendar(APRIL.start, APRIL.end, subject(sundayOff), holidays);
    expect(cal.weekOffDays).toBe(4);
    expect(cal.holidayDays).toBe(0);
    expect(cal.workingDays + cal.weekOffDays + cal.holidayDays).toBe(30);
  });

  it("leaves an optional holiday as a working day", () => {
    const holidays: HolidayEntry[] = [
      { id: "h1", name: "Optional festival", date: "2026-04-15", paid: true, optional: true },
    ];
    const cal = buildPeriodCalendar(APRIL.start, APRIL.end, subject(sundayOff), holidays);
    expect(cal.holidayDays).toBe(0);
    expect(cal.workingDays).toBe(26);
    expect(cal.days.find((d) => d.date === "2026-04-15")?.holiday?.optional).toBe(true);
  });

  it("applies a department-scoped holiday only to that department", () => {
    const holidays: HolidayEntry[] = [
      { id: "h1", name: "Sales offsite", date: "2026-04-15", paid: true, optional: false, departmentIds: ["dept_2"] },
    ];
    const mine = buildPeriodCalendar(APRIL.start, APRIL.end, subject(sundayOff), holidays);
    expect(mine.holidayDays).toBe(0);

    const theirs = buildPeriodCalendar(
      APRIL.start,
      APRIL.end,
      { ...subject(sundayOff), departmentId: "dept_2" },
      holidays,
    );
    expect(theirs.holidayDays).toBe(1);
  });

  it("applies an employee-specific holiday to that person only", () => {
    const holidays: HolidayEntry[] = [
      { id: "h1", name: "Personal", date: "2026-04-15", paid: true, optional: false, employeeIds: ["emp_9"] },
    ];
    expect(buildPeriodCalendar(APRIL.start, APRIL.end, subject(sundayOff), holidays).holidayDays).toBe(0);
    expect(
      buildPeriodCalendar(
        APRIL.start,
        APRIL.end,
        { ...subject(sundayOff), employeeId: "emp_9" },
        holidays,
      ).holidayDays,
    ).toBe(1);
  });

  it("tracks unpaid holidays separately from paid ones", () => {
    const holidays: HolidayEntry[] = [
      { id: "h1", name: "Unpaid shutdown", date: "2026-04-15", paid: false, optional: false },
    ];
    const cal = buildPeriodCalendar(APRIL.start, APRIL.end, subject(sundayOff), holidays);
    expect(cal.holidayDays).toBe(1);
    expect(cal.paidHolidayDays).toBe(0);
  });

  it("every day in the period gets exactly one kind", () => {
    const cal = buildPeriodCalendar(APRIL.start, APRIL.end, subject(sundayOff), []);
    expect(cal.days).toHaveLength(30);
    expect(new Set(cal.days.map((d) => d.date)).size).toBe(30);
  });
});
