import { PrismaClient } from "@prisma/client";

import { defaultOnHolidays } from "../src/domain/org/holidayCatalogue";

/**
 * Put the three gazetted national days on every existing calendar, once.
 *
 * Superseded for ordinary running by the maintenance job, which keeps every
 * calendar a year ahead by itself. This stays for the one-off case: an
 * organisation restored from a backup, or a year the job never covered.
 *
 * Republic Day, Independence Day and Gandhi Jayanti are the same date
 * everywhere and every establishment in the country is closed on them. An
 * organisation whose calendar calls one of them a working day marks everybody
 * absent on it and docks a day's pay, and nothing else in the product ever says
 * why.
 *
 * `provisionTenant` seeds them from now on. This is for the organisations that
 * already exist — which on this instance means all of them, because provisioning
 * used to seed no holidays at all.
 *
 * **Additive only.** It creates rows and never deletes or edits one. A holiday
 * somebody already typed in on that date under a different name is left exactly
 * where it is and reported as a clash, because the unique key is
 * (organisation, name, date) and two holidays on one day is the organisation's
 * business, not this script's.
 *
 * **A closed payroll month is skipped**, for the same reason `deleteHoliday`
 * protects one: adding a holiday to a month that has already been approved
 * changes the working days it was calculated from without changing a rupee of
 * what was paid.
 *
 *   docker exec -it <container> node scripts/seed-national-holidays.mjs            # dry run
 *   docker exec -it <container> node scripts/seed-national-holidays.mjs --apply
 */

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");

/** This year and next, so a calendar does not run out in December. */
function years(): number[] {
  const now = new Date().getUTCFullYear();
  return [now, now + 1];
}

interface Planned {
  slug: string;
  name: string;
  date: string;
  outcome: "CREATE" | "ALREADY THERE" | "CLASH" | "PAYROLL CLOSED";
  detail?: string;
}

async function main(): Promise<void> {
  const organizations = await prisma.organization.findMany({
    select: { id: true, slug: true, name: true },
    orderBy: { slug: "asc" },
  });

  const planned: Planned[] = [];

  for (const org of organizations) {
    for (const year of years()) {
      for (const holiday of defaultOnHolidays(year)) {
        const date = new Date(`${holiday.date}T00:00:00.000Z`);

        const [sameName, sameDate, lockedRun] = await Promise.all([
          prisma.holiday.findFirst({
            where: { organizationId: org.id, name: holiday.name, date },
            select: { id: true },
          }),
          prisma.holiday.findFirst({
            where: { organizationId: org.id, date },
            select: { name: true },
          }),
          prisma.payrollRun.findFirst({
            where: {
              organizationId: org.id,
              periodYear: year,
              periodMonth: Number(holiday.date.slice(5, 7)),
              status: { in: ["APPROVED", "LOCKED"] },
            },
            select: { status: true },
          }),
        ]);

        if (sameName) {
          planned.push({ slug: org.slug, name: holiday.name, date: holiday.date, outcome: "ALREADY THERE" });
          continue;
        }
        if (lockedRun) {
          planned.push({
            slug: org.slug,
            name: holiday.name,
            date: holiday.date,
            outcome: "PAYROLL CLOSED",
            detail: `${lockedRun.status.toLowerCase()} run for that month`,
          });
          continue;
        }
        if (sameDate) {
          planned.push({
            slug: org.slug,
            name: holiday.name,
            date: holiday.date,
            outcome: "CLASH",
            detail: `${sameDate.name} is already on that date`,
          });
          continue;
        }

        planned.push({ slug: org.slug, name: holiday.name, date: holiday.date, outcome: "CREATE" });
      }
    }
  }

  const counts = planned.reduce<Record<string, number>>((acc, row) => {
    acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
    return acc;
  }, {});

  console.log(APPLY ? "Applying." : "Dry run. Nothing is written.");
  console.log(`${organizations.length} organisation(s), ${years().join(" and ")}.\n`);

  for (const row of planned) {
    const detail = row.detail ? `  (${row.detail})` : "";
    console.log(`  ${row.outcome.padEnd(14)} ${row.slug.padEnd(20)} ${row.name} ${row.date}${detail}`);
  }

  console.log(
    `\n${Object.entries(counts)
      .map(([outcome, n]) => `${outcome}: ${n}`)
      .join("   ")}`,
  );

  if (!APPLY) {
    console.log("\nRe-run with --apply to write the CREATE rows.");
    return;
  }

  const toCreate = planned.filter((p) => p.outcome === "CREATE");
  if (toCreate.length === 0) {
    console.log("\nNothing to create.");
    return;
  }

  const bySlug = new Map(organizations.map((o) => [o.slug, o.id]));
  const result = await prisma.holiday.createMany({
    data: toCreate.map((row) => ({
      organizationId: bySlug.get(row.slug)!,
      name: row.name,
      date: new Date(`${row.date}T00:00:00.000Z`),
      type: "PUBLIC" as const,
      paid: true,
      optional: false,
      note: "National holiday",
    })),
    // Belt and braces against a row appearing between the plan and the write.
    skipDuplicates: true,
  });

  console.log(`\nCreated ${result.count} holiday row(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
