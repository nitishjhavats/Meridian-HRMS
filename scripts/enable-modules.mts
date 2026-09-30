import { PrismaClient } from "@prisma/client";
import { MODULES } from "../src/lib/features";

/**
 * Switches on the modules that only shipped off.
 *
 *   npm run modules:enable              # says what it would change
 *   npm run modules:enable -- --apply   # changes it
 *
 * Seven modules used to default off — exit, reimbursements, onboarding, assets,
 * recognition, chat and performance — so a new organisation could not see
 * features it was paying for until somebody found the modules screen and
 * guessed which ones existed. Chat was the visible one: the nav entry was
 * written and the icon never appeared beside Announcements.
 *
 * Flipping the default in code fixes new organisations and nothing else,
 * because provisioning writes an `OrgModuleSetting` row for every module at
 * creation. This moves the rows already out there.
 *
 * **It will not switch on anything an administrator switched off.**
 * `updatedById` is null until somebody changes a row through the settings
 * screen, so a null is "this is how it was provisioned" and a name is "somebody
 * decided this". Overriding the second would be the script overruling the
 * customer about their own product.
 *
 * Safe to re-run.
 */

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const orgArg = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length);

const wanted = MODULES.filter((m) => m.defaultEnabled).map((m) => m.key);

const rows = await prisma.orgModuleSetting.findMany({
  where: {
    enabled: false,
    moduleKey: { in: wanted },
    ...(orgArg ? { organization: { slug: orgArg } } : {}),
  },
  select: {
    id: true,
    moduleKey: true,
    updatedById: true,
    organization: { select: { name: true, slug: true } },
  },
  orderBy: [{ organizationId: "asc" }, { moduleKey: "asc" }],
});

const shipped = rows.filter((r) => r.updatedById === null);
const chosen = rows.filter((r) => r.updatedById !== null);

if (rows.length === 0) {
  console.log("\n  Every module is already on wherever it ships on.\n");
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`\n  ${shipped.length} module(s) off because that is how they shipped:`);
for (const r of shipped) console.log(`    ${r.organization.slug} · ${r.moduleKey}`);

if (chosen.length > 0) {
  console.log(`\n  ${chosen.length} switched off by somebody, and left alone:`);
  for (const r of chosen) console.log(`    ${r.organization.slug} · ${r.moduleKey}`);
}

if (!apply) {
  console.log("\n  Dry run. Nothing was written. Add --apply to switch the first group on.\n");
  await prisma.$disconnect();
  process.exit(0);
}

if (shipped.length === 0) {
  console.log("\n  Nothing to write.\n");
  await prisma.$disconnect();
  process.exit(0);
}

const result = await prisma.orgModuleSetting.updateMany({
  where: { id: { in: shipped.map((r) => r.id) } },
  data: { enabled: true },
});

console.log(`\n  Switched ${result.count} module(s) on.\n`);
await prisma.$disconnect();
