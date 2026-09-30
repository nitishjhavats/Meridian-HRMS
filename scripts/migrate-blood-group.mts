/**
 * Encrypts the blood groups that were stored in plaintext.
 *
 *   npm run migrate:bloodgroup
 *
 * `Employee.bloodGroup` sat unencrypted beside encrypted bank details, PAN and
 * Aadhaar for as long as the column existed. It is health data under the SPDI
 * Rules 2011, and it is collected for one reason: so somebody can tell an
 * ambulance.
 *
 * SQL cannot do this — the key lives in the application — so the cipher column
 * was added first and the plaintext left in place. This moves the data across
 * and clears the plaintext. Run it once per environment; it is idempotent, and
 * safe to run again.
 *
 * Once it has run everywhere, `Employee.bloodGroup` can be dropped in a
 * migration of its own.
 */
import { PrismaClient } from "@prisma/client";
import { encryptOptional } from "../src/lib/crypto/field";

const prisma = new PrismaClient();
const dryRun = !process.argv.includes("--apply");

const rows = await prisma.employee.findMany({
  where: { bloodGroup: { not: null } },
  select: { id: true, employeeCode: true, bloodGroup: true, bloodGroupCipher: true },
});

console.log(`\n${rows.length} employee(s) still hold a plaintext blood group.\n`);

if (rows.length === 0) {
  console.log("Nothing to do. The column can be dropped.\n");
  await prisma.$disconnect();
  process.exit(0);
}

if (dryRun) {
  for (const row of rows.slice(0, 10)) {
    console.log(`  ${row.employeeCode}  ${row.bloodGroupCipher ? "(already encrypted too)" : ""}`);
  }
  if (rows.length > 10) console.log(`  … and ${rows.length - 10} more`);
  console.log("\nDry run. Re-run with --apply to encrypt them.\n");
  await prisma.$disconnect();
  process.exit(0);
}

let moved = 0;
for (const row of rows) {
  await prisma.employee.update({
    where: { id: row.id },
    data: {
      // Never overwrite a cipher that is already there: the app has been
      // writing them since the column was added.
      ...(row.bloodGroupCipher ? {} : { bloodGroupCipher: encryptOptional(row.bloodGroup) }),
      bloodGroup: null,
    },
  });
  moved += 1;
}

console.log(`Encrypted ${moved}. The plaintext column is empty and can be dropped.\n`);
await prisma.$disconnect();
