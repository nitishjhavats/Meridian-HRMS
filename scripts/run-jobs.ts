/**
 * Maintenance jobs, from a terminal.
 *
 *   npm run jobs
 *
 * In production these run inside the server instead, triggered by the platform
 * scheduler against `POST /api/jobs/run` — a container has no `.env` file to
 * read and no `tsx` to run TypeScript with. Both paths call the same
 * `runMaintenanceJobs()`, so there is one implementation and one thing to test.
 *
 * Every job is idempotent, so running it twice is harmless and an interrupted
 * run simply resumes on the next pass.
 */

import { runMaintenanceJobs } from "../src/lib/jobs";
import { prisma } from "../src/lib/db/prisma";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

console.log("\nMaintenance jobs\n");

const summary = await runMaintenanceJobs();

console.log(`  retention window    ${summary.selfies.retentionDays} days`);
console.log(`  awaiting purge      ${summary.selfies.awaitingPurge}`);
console.log(
  `  purged selfies      ${summary.selfies.purged} (${mb(summary.selfies.freedBytes)} freed)`,
);
// Every field of `JobsSummary`, because three of them -- the location trail,
// the login events and the audit identifiers -- were computed on every run and
// shown to nobody. A retention job silently doing nothing goes unnoticed
// longest on exactly this path.
console.log(`  location trail      ${summary.locationTrail} attendance rows cleared`);
console.log(`  login events        ${summary.loginEvents} removed`);
console.log(`  audit identifiers   ${summary.auditIdentifiers} rows stripped`);
console.log(`  orphan files        ${summary.orphanFiles} removed`);
console.log(
  `  expired exports     ${summary.expiredExports.expired} removed (${mb(summary.expiredExports.freedBytes)} freed)`,
);
console.log(`  rate-limit counters ${summary.rateLimitRows} expired rows removed`);
console.log(
  `  day close           ${summary.attendance.absentCreated} absences recorded, ${summary.attendance.openDaysClosed} open check-ins settled, ${summary.attendance.leaveWithoutRow} on leave and ${summary.attendance.unmarkable} unable to mark left blank (${summary.attendance.organizations} organisations)`,
);
console.log(
  `  confirmations due   ${summary.confirmationsDue.employees} people across ${summary.confirmationsDue.organizations} organisations`,
);
console.log(
  `  chat                ${summary.chat.messages} messages and ${summary.chat.threads} empty threads removed (${summary.chat.retentionDays} days)`,
);
console.log(
  `  holidays            ${summary.holidays.created} row(s) across ${summary.holidays.organizations} organisation(s), through ${summary.holidays.throughYear}`,
);
console.log(`\n  done in ${summary.durationMs} ms\n`);

await prisma.$disconnect();
