/**
 * Reduces every stored Aadhaar number to its last four digits.
 *
 *   npm run mask:aadhaar            # dry run, counts only
 *   npm run mask:aadhaar -- --apply # does it
 *
 * **This cannot be undone.** The full numbers are encrypted, and once they are
 * replaced there is nothing to decrypt back. Run it after a backup you have
 * actually restored from, never before.
 *
 * Since *Puttaswamy*, a private company's use of Aadhaar is heavily restricted,
 * and holding twelve digits carries obligations — and a breach exposure — that
 * holding four does not. Four is enough to confirm which number an employee
 * means; it is not enough to be used as an identity anywhere.
 *
 * Idempotent: a value that is already four digits is left alone, so running it
 * twice is safe and running it after a partial failure finishes the job.
 */
import { PrismaClient } from "@prisma/client";
import { decryptOptional, encryptOptional } from "../src/lib/crypto/field";
import { aadhaarLastFour, isAadhaarLastFour } from "../src/domain/employees/aadhaar";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

const rows = await prisma.employee.findMany({
  where: { aadhaarCipher: { not: null } },
  select: { id: true, employeeCode: true, aadhaarCipher: true, organization: { select: { name: true } } },
});

let full = 0;
let already = 0;
let unreadable = 0;
const toChange: { id: string; code: string; org: string; lastFour: string }[] = [];

for (const row of rows) {
  const value = decryptOptional(row.aadhaarCipher);
  if (value === null) {
    // Encrypted with a key this environment does not have, which is a much
    // bigger problem than this script — say so rather than skipping quietly.
    unreadable += 1;
    continue;
  }
  if (isAadhaarLastFour(value)) {
    already += 1;
    continue;
  }
  const lastFour = aadhaarLastFour(value);
  if (!lastFour) {
    unreadable += 1;
    continue;
  }
  full += 1;
  toChange.push({ id: row.id, code: row.employeeCode, org: row.organization.name, lastFour });
}

console.log(`\n${rows.length} employee(s) have an Aadhaar on file.`);
console.log(`  ${already} already reduced to four digits`);
console.log(`  ${full} still hold the full number`);
if (unreadable > 0) {
  console.log(`  ${unreadable} could not be read — wrong encryption key, or not a number`);
}

if (full === 0) {
  console.log("\nNothing to do.\n");
  await prisma.$disconnect();
  process.exit(0);
}

const byOrg = new Map<string, number>();
for (const row of toChange) byOrg.set(row.org, (byOrg.get(row.org) ?? 0) + 1);
console.log("\nBy organisation:");
for (const [org, count] of byOrg) console.log(`  ${org.padEnd(30)} ${count}`);

if (!apply) {
  console.log("\nDry run — nothing was changed. Re-run with --apply once you have a backup.\n");
  await prisma.$disconnect();
  process.exit(0);
}

for (const row of toChange) {
  await prisma.employee.update({
    where: { id: row.id },
    data: { aadhaarCipher: encryptOptional(row.lastFour) },
  });
}

console.log(`\nReduced ${toChange.length}. The full numbers are gone and cannot be recovered.\n`);
await prisma.$disconnect();
