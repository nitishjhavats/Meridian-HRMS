import type { Prisma, PrismaClient } from "@prisma/client";
import type { DateOnly } from "@/domain/date";
import { buildPeriodCalendar, type DayKind } from "@/domain/calendar";
import { resolveWeeklyOff } from "@/services/org/weeklyOff";

/**
 * What the calendar says one date is for one person, before attendance.
 *
 * Built exactly the way `recordAttendance` builds it at the moment of a mark
 * -- the person's own rest days over their pattern over the organisation's
 * default, plus the day's holidays, through `buildPeriodCalendar` for that
 * single date -- so a decision taken about a day afterwards reads the same
 * calendar the mark did. The review queue is the caller: rejecting a
 * check-in on a Sunday wrote ABSENT for the Sunday, and payroll docked it.
 */
export async function dayKindFor(
  db: Prisma.TransactionClient | PrismaClient,
  organizationId: string,
  employee: {
    id: string;
    departmentId: string | null;
    weeklyOffConfig: unknown;
    weeklyOffPattern: { config: unknown } | null;
  },
  date: DateOnly,
): Promise<DayKind> {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const weeklyOff = await resolveWeeklyOff(db, organizationId, employee);

  const holidays = await db.holiday.findMany({
    where: { organizationId, date: dayStart },
    select: {
      id: true,
      name: true,
      paid: true,
      optional: true,
      departmentIds: true,
      employeeIds: true,
      regions: true,
    },
  });

  const calendar = buildPeriodCalendar(
    date,
    date,
    { employeeId: employee.id, departmentId: employee.departmentId, weeklyOff },
    holidays.map((h) => ({ ...h, date })),
  );

  return calendar.days[0]?.kind ?? "WORKING";
}
