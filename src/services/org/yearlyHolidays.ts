import { prisma } from "@/lib/db/prisma";

import { defaultOnHolidays } from "@/domain/org/holidayCatalogue";

/**
 * Keeping every calendar a year ahead, by itself.
 *
 * The three national days arrive on, arrive again every year, and can be
 * switched off. Those three facts only coexist because of
 * `Organization.holidaysSeededThrough`: this seeds forward from it and records
 * that it did, so it never revisits a year. A holiday somebody deleted stays
 * deleted rather than reappearing on the next run — which is the difference
 * between a default and a rule nobody can escape.
 *
 * Runs from the maintenance job, so nobody has to remember it in January. An
 * organisation whose calendar ran out in December is one that calls 26 January
 * a working day, and nobody notices until somebody is marked absent on it.
 */

/** How far ahead the calendar is kept. One year, so December is never empty. */
export const HOLIDAY_LEAD_YEARS = 1;

export interface YearlyHolidaySummary {
  /** Organisations that gained at least one row. */
  organizations: number;
  /** Rows created across all of them. */
  created: number;
  /** The furthest year now filled in. */
  throughYear: number;
}

export async function seedYearlyHolidays(now = new Date()): Promise<YearlyHolidaySummary> {
  const throughYear = now.getUTCFullYear() + HOLIDAY_LEAD_YEARS;

  const organizations = await prisma.organization.findMany({
    where: {
      OR: [{ holidaysSeededThrough: null }, { holidaysSeededThrough: { lt: throughYear } }],
    },
    select: { id: true, holidaysSeededThrough: true },
  });

  let created = 0;
  let touched = 0;

  for (const org of organizations) {
    /**
     * Where to start.
     *
     * `null` means this organisation predates the column, so it starts at this
     * year rather than at the beginning of time — filling 2019 would put
     * holidays into months whose payroll was closed years ago.
     */
    const from = org.holidaysSeededThrough ?? now.getUTCFullYear();
    const years: number[] = [];
    for (let year = from; year <= throughYear; year++) years.push(year);

    const rows = years.flatMap((year) =>
      defaultOnHolidays(year).map((holiday) => ({
        organizationId: org.id,
        name: holiday.name,
        date: new Date(`${holiday.date}T00:00:00.000Z`),
        type: "PUBLIC" as const,
        paid: true,
        optional: false,
        note: "National holiday",
      })),
    );
    if (rows.length === 0) continue;

    /**
     * `skipDuplicates` on (organisation, name, date).
     *
     * It is the whole safety of running this every day: a row already there is
     * left exactly as it is, including one an administrator edited to unpaid or
     * optional. This adds; it never corrects.
     */
    const result = await prisma.holiday.createMany({ data: rows, skipDuplicates: true });

    await prisma.organization.update({
      where: { id: org.id },
      data: { holidaysSeededThrough: throughYear },
    });

    created += result.count;
    if (result.count > 0) touched += 1;
  }

  return { organizations: touched, created, throughYear };
}
