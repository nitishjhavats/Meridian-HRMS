/**
 * Period calendar: for a date range and an employee, decide what each day *is*
 * before any attendance is considered — working day, week off, or holiday.
 */

import { type DateOnly, eachDay } from "../date";
import { type WeeklyOffConfig, isWeeklyOff } from "./weeklyOff";

export * from "./weeklyOff";

export type DayKind = "WORKING" | "WEEK_OFF" | "HOLIDAY";

export interface HolidayEntry {
  id: string;
  name: string;
  date: DateOnly;
  paid: boolean;
  optional: boolean;
  /** Empty array = applies to everyone. */
  departmentIds?: string[];
  employeeIds?: string[];
  regions?: string[];
}

export interface CalendarSubject {
  employeeId: string;
  departmentId?: string | null;
  region?: string | null;
  weeklyOff: WeeklyOffConfig;
}

export interface CalendarDay {
  date: DateOnly;
  kind: DayKind;
  holiday?: { id: string; name: string; paid: boolean; optional: boolean };
}

export interface PeriodCalendar {
  days: CalendarDay[];
  totalDays: number;
  workingDays: number;
  weekOffDays: number;
  holidayDays: number;
  paidHolidayDays: number;
}

function holidayApplies(holiday: HolidayEntry, subject: CalendarSubject): boolean {
  if (holiday.employeeIds?.length) return holiday.employeeIds.includes(subject.employeeId);
  if (holiday.departmentIds?.length) {
    return subject.departmentId != null && holiday.departmentIds.includes(subject.departmentId);
  }
  if (holiday.regions?.length) {
    return subject.region != null && holiday.regions.includes(subject.region);
  }
  return true;
}

/**
 * Holidays win over week-offs for *labelling*, but a holiday landing on a week-off
 * is not double-counted: it stays a WEEK_OFF so payable-day maths cannot inflate.
 */
export function buildPeriodCalendar(
  start: DateOnly,
  end: DateOnly,
  subject: CalendarSubject,
  holidays: readonly HolidayEntry[],
): PeriodCalendar {
  const applicable = new Map<DateOnly, HolidayEntry>();
  for (const h of holidays) {
    if (holidayApplies(h, subject) && !applicable.has(h.date)) applicable.set(h.date, h);
  }

  const days: CalendarDay[] = [];
  let workingDays = 0;
  let weekOffDays = 0;
  let holidayDays = 0;
  let paidHolidayDays = 0;

  for (const date of eachDay(start, end)) {
    const off = isWeeklyOff(date, subject.weeklyOff);
    const holiday = applicable.get(date);

    if (off) {
      days.push({ date, kind: "WEEK_OFF" });
      weekOffDays++;
      continue;
    }
    if (holiday && !holiday.optional) {
      days.push({
        date,
        kind: "HOLIDAY",
        holiday: { id: holiday.id, name: holiday.name, paid: holiday.paid, optional: holiday.optional },
      });
      holidayDays++;
      if (holiday.paid) paidHolidayDays++;
      continue;
    }
    days.push(
      holiday
        ? {
            date,
            kind: "WORKING",
            holiday: { id: holiday.id, name: holiday.name, paid: holiday.paid, optional: true },
          }
        : { date, kind: "WORKING" },
    );
    workingDays++;
  }

  return {
    days,
    totalDays: days.length,
    workingDays,
    weekOffDays,
    holidayDays,
    paidHolidayDays,
  };
}

export function calendarDayMap(calendar: PeriodCalendar): Map<DateOnly, CalendarDay> {
  return new Map(calendar.days.map((d) => [d.date, d]));
}
