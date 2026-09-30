/**
 * Close attendance days by hand.
 *
 *   npm run attendance:close -- --org=<slug> --from=YYYY-MM-DD            # dry run
 *   npm run attendance:close -- --org=<slug> --from=YYYY-MM-DD --apply
 *   node dist/close-attendance-days.mjs --org=<slug> --from=YYYY-MM-DD    # in the container
 *
 * The nightly maintenance run closes the last seven days on its own. This is
 * the same close with a chosen start date, for a back-fill an owner has asked
 * for: every working day with no mark becomes an ABSENT row, every check-in
 * with no check-out is settled through the organisation's missing-checkout
 * rule. Overridden rows, leave, rest days and anything already settled are
 * never touched. A working day an approved leave request covers, and a
 * working day for somebody who could not have marked at all (no work
 * location where one is required; self-marking off and no kiosk), are left
 * blank, listed and counted rather than written ABSENT.
 *
 * Dry run by default. It prints every row it would write, person by person,
 * so the owner can read the list -- some of those absences will turn out to
 * be leave nobody recorded, and that is a conversation to have before the
 * rows exist, not after. `--apply` writes them. `--org` is required unless
 * `--all` is given, because a back-fill is a decision one organisation makes,
 * and the organisation has to be ACTIVE: the close reads no other state.
 *
 * Production has no `tsx`; the Dockerfile bundles this to
 * `dist/close-attendance-days.mjs`.
 */

import { PrismaClient } from "@prisma/client";

import { closeAttendanceDays } from "../src/services/attendance/dayClose";
import { isDateOnly } from "../src/domain/date";

const apply = process.argv.includes("--apply");
const all = process.argv.includes("--all");
const orgArg = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length);
const fromArg = process.argv.find((a) => a.startsWith("--from="))?.slice("--from=".length);

if (!orgArg && !all) {
  console.error("Say which organisation: --org=<slug>, or --all for every one.");
  process.exit(1);
}
if (!fromArg || !isDateOnly(fromArg)) {
  console.error("Say where to start: --from=YYYY-MM-DD.");
  process.exit(1);
}

const prisma = new PrismaClient();
const organization = orgArg
  ? await prisma.organization.findUnique({
      where: { slug: orgArg },
      select: { id: true, name: true, status: true },
    })
  : null;
if (orgArg && !organization) {
  console.error(`No organisation with slug "${orgArg}".`);
  await prisma.$disconnect();
  process.exit(1);
}
// The close only reads ACTIVE organisations, so a slug in any other state
// printed "nothing old enough to close" and looked like a run that found
// nothing rather than one that never looked. Say which.
if (organization && organization.status !== "ACTIVE") {
  console.error(
    `${organization.name} (${orgArg}) is ${organization.status}, not ACTIVE. The close only touches active organisations; activate it first.`,
  );
  await prisma.$disconnect();
  process.exit(1);
}

const now = new Date();
const daysBack = Math.ceil((now.getTime() - new Date(`${fromArg}T00:00:00.000Z`).getTime()) / 86_400_000) + 1;

const summary = await closeAttendanceDays({
  now,
  from: fromArg,
  lookbackDays: Math.max(daysBack, 1),
  organizationId: organization?.id,
  dryRun: !apply,
});

console.log(`\nClosing attendance days from ${fromArg}${apply ? "" : " (dry run)"}\n`);
for (const org of summary.perOrg) {
  console.log(`${org.name} (${org.slug})`);
  if (org.dates.length === 0) {
    console.log("  nothing old enough to close\n");
    continue;
  }
  console.log(`  dates ${org.dates[0]} to ${org.dates[org.dates.length - 1]}`);
  for (const row of org.planned) {
    console.log(`  ${row.employeeCode.padEnd(12)} ${row.date}  ${row.change}  (${row.employeeName})`);
  }
  // Blanks left blank on purpose, so the owner reading the list can see why
  // a name they expected is not on it.
  for (const row of org.skipped) {
    const why = row.reason === "ON_LEAVE" ? "left blank: approved leave" : "left blank: cannot mark";
    console.log(`  ${row.employeeCode.padEnd(12)} ${row.date}  ${why}  (${row.employeeName})`);
  }
  console.log(
    `  ${org.absentCreated} absent, ${org.openDaysClosed} open check-ins settled, ${org.leaveWithoutRow} on approved leave, ${org.unmarkable} unable to mark\n`,
  );
}
console.log(
  `${summary.perOrg.length} organisation(s): ${summary.absentCreated} absent, ${summary.openDaysClosed} settled, ${summary.leaveWithoutRow} on leave and ${summary.unmarkable} unable to mark left blank.`,
);
if (!apply) console.log("Dry run. Nothing was written. Add --apply to write.");

await prisma.$disconnect();
