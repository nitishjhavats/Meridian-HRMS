import { PrismaClient } from "@prisma/client";
import { LETTER_CATEGORIES } from "../src/domain/letters/template";
import { isShippedBody } from "../src/domain/letters/shipped";

/**
 * Hands the shipped wording back to organisations whose letters were frozen.
 *
 *   npm run unfreeze:letters              # says what it would change
 *   npm run unfreeze:letters -- --apply   # changes it
 *
 * **The defect this repairs.** `LetterTemplate.title` and `bodyTemplate` used to
 * be NOT NULL, and `setFrameworkSignature` has to create a row to hang an
 * uploaded signature on — so it filled both by copying the built-in text
 * verbatim. Any organisation that scanned in a signature therefore froze that
 * day's wording, and no later improvement to the shipped letters could ever
 * reach them again. They had customised nothing; the product decided they had.
 *
 * The columns are nullable now and `merge` falls back field by field, so the
 * repair is to **null the text on rows that only ever held a copy of a default**
 * — after which those organisations follow the built-ins again, permanently.
 * The signature stays exactly where it is.
 *
 * **What it will not touch.** A body somebody actually rewrote. Silently
 * replacing the words of a document an organisation issues to its own staff is
 * not a migration, it is a liability. Those are listed instead, with what makes
 * them different, so a person can decide — and the template editor now shows
 * the same notice in the product, with one click to restore.
 *
 * This replaces `strip:signoff`, which rewrote the same rows in place. Nulling
 * is strictly better: a rewritten row is still frozen against the *next*
 * improvement, and this one is not.
 *
 * Safe to re-run.
 */

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

const rows = await prisma.letterTemplate.findMany({
  select: {
    id: true,
    category: true,
    title: true,
    bodyTemplate: true,
    signatureKey: true,
    organization: { select: { name: true, slug: true } },
  },
  orderBy: [{ organizationId: "asc" }, { category: "asc" }],
});

const alreadyFree: string[] = [];
const unfreeze: { id: string; label: string; hasSignature: boolean }[] = [];
const customised: string[] = [];

for (const row of rows) {
  const label = `${row.organization.slug}/${row.category}`;

  if (row.bodyTemplate === null && row.title === null) {
    alreadyFree.push(label);
    continue;
  }

  if (isShippedBody(row.category as never, row.bodyTemplate)) {
    unfreeze.push({ id: row.id, label, hasSignature: row.signatureKey !== null });
  } else {
    customised.push(label);
  }
}

console.log(`\n  ${rows.length} template row(s) across ${LETTER_CATEGORIES.length} categories.\n`);
console.log(`  ${alreadyFree.length} already following the built-in text.`);

if (unfreeze.length > 0) {
  console.log(`\n  ${unfreeze.length} holding a copy of a shipped default — safe to unfreeze:`);
  for (const r of unfreeze) {
    console.log(`    ${r.label}${r.hasSignature ? "  (signature kept)" : ""}`);
  }
}

if (customised.length > 0) {
  console.log(`\n  ${customised.length} carry wording somebody actually wrote.`);
  console.log("  Left alone deliberately. If one of these is stale, restore it from the");
  console.log("  template editor, which shows the built-in beside it:");
  for (const c of customised) console.log(`    ${c}`);
}

if (!apply) {
  console.log("\n  Dry run. Nothing was written. Add --apply to unfreeze the safe ones.\n");
  await prisma.$disconnect();
  process.exit(0);
}

if (unfreeze.length === 0) {
  console.log("\n  Nothing to write.\n");
  await prisma.$disconnect();
  process.exit(0);
}

await prisma.$transaction(
  unfreeze.map((r) =>
    prisma.letterTemplate.update({
      where: { id: r.id },
      data: {
        title: null,
        bodyTemplate: null,
        headerText: null,
        footerText: null,
        placeholders: [],
      },
    }),
  ),
);

// A row that now holds nothing at all is an override of nothing. Deleting it
// keeps "customised" honest on the templates list; a row with a signature stays.
const emptied = await prisma.letterTemplate.deleteMany({
  where: {
    id: { in: unfreeze.filter((r) => !r.hasSignature).map((r) => r.id) },
    signatureKey: null,
    signatoryName: null,
    signatoryTitle: null,
  },
});

console.log(
  `\n  Unfroze ${unfreeze.length} template(s); removed ${emptied.count} row(s) that held nothing.\n`,
);
await prisma.$disconnect();
