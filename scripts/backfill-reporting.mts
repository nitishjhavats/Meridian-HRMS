/**
 * Gives a reporting line to everyone the designation chart can place.
 *
 *   npm run backfill:reporting                 # every organisation, dry run
 *   npm run backfill:reporting -- --org=acme   # one organisation
 *   npm run backfill:reporting -- --apply      # writes
 *
 * **Why this exists.** `/api/settings/structure/reporting` had no caller
 * anywhere in the product, so `ReportingRelationship` was empty in every
 * organisation ever created through it. `teamEmployeeIds` returned `[self]` for
 * every manager, every `.team` permission scope resolved to one person, and
 * every leave request fell through to the org-wide HR fallback. The employee
 * form now sets a line one person at a time; this places the backlog.
 *
 * **What it will not do.** It writes a line only where the chart gives exactly
 * one answer — the person holds a designation, that designation reports to
 * exactly one other, and exactly one active person holds *that*. Anything else
 * is printed and skipped, because a wrong line is worse than no line: no line
 * sends leave to HR, and a wrong one hands somebody's approvals to a stranger
 * who will not know to question them. `--apply` never guesses.
 *
 * The rule is `domain/org/suggestManager`, the same function the employee form
 * calls, so the bulk answer and the on-screen suggestion cannot drift.
 *
 * Safe to re-run: anyone who already has a live PRIMARY line is left alone.
 */
import { PrismaClient } from "@prisma/client";
import { suggestManagers, type ManagerCandidate } from "../src/domain/org/suggestManager";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const orgArg = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length);

/** The line starts today, in ISO date form — the shape the column expects. */
const TODAY = new Date().toISOString().slice(0, 10);

const ACTIVE_STATES = { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] } as const;

interface Placement {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  managerId: string;
  managerName: string;
}

interface Skip {
  employeeCode: string;
  employeeName: string;
  reason: string;
}

const organizations = await prisma.organization.findMany({
  where: orgArg ? { slug: orgArg } : {},
  select: { id: true, name: true, slug: true },
  orderBy: { name: "asc" },
});

if (organizations.length === 0) {
  console.log(orgArg ? `\nNo organisation with slug "${orgArg}".\n` : "\nNo organisations.\n");
  await prisma.$disconnect();
  process.exit(1);
}

let totalPlaced = 0;
let totalSkipped = 0;
let totalAlready = 0;

for (const org of organizations) {
  const [people, edges, liveLines] = await Promise.all([
    prisma.employee.findMany({
      where: { organizationId: org.id, active: true, employmentState: ACTIVE_STATES },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        designationId: true,
        designation: { select: { title: true } },
      },
      orderBy: { employeeCode: "asc" },
    }),
    prisma.designationReporting.findMany({
      where: { organizationId: org.id },
      select: { designationId: true, reportsToDesignationId: true },
    }),
    prisma.reportingRelationship.findMany({
      where: { organizationId: org.id, type: "PRIMARY", endDate: null },
      select: { employeeId: true },
    }),
  ]);

  const hasLine = new Set(liveLines.map((l) => l.employeeId));
  const designationParents: Record<string, string[]> = {};
  for (const edge of edges) {
    designationParents[edge.designationId] = [
      ...(designationParents[edge.designationId] ?? []),
      edge.reportsToDesignationId,
    ];
  }

  const name = (p: { firstName: string; lastName: string | null }) =>
    [p.firstName, p.lastName].filter(Boolean).join(" ");

  const candidates: ManagerCandidate[] = people.map((p) => ({
    id: p.id,
    name: name(p),
    designationId: p.designationId,
  }));

  const placements: Placement[] = [];
  const skips: Skip[] = [];
  let already = 0;

  for (const person of people) {
    if (hasLine.has(person.id)) {
      already += 1;
      continue;
    }

    const suggested = suggestManagers({
      designationId: person.designationId,
      designationParents,
      managers: candidates,
      excludeEmployeeId: person.id,
    });

    if (suggested.length === 1) {
      placements.push({
        employeeId: person.id,
        employeeCode: person.employeeCode,
        employeeName: name(person),
        managerId: suggested[0]!.id,
        managerName: suggested[0]!.name,
      });
      continue;
    }

    skips.push({
      employeeCode: person.employeeCode,
      employeeName: name(person),
      reason: !person.designationId
        ? "no designation"
        : (designationParents[person.designationId] ?? []).length === 0
          ? `"${person.designation?.title ?? "?"}" reports to nothing in the chart`
          : suggested.length === 0
            ? `nobody active holds the designation above "${person.designation?.title ?? "?"}"`
            : `${suggested.length} people hold the designation above "${person.designation?.title ?? "?"}"`,
    });
  }

  console.log(`\n${org.name} (${org.slug}) — ${people.length} active`);
  console.log(`  ${already} already have a manager`);
  console.log(`  ${placements.length} the chart can place`);
  console.log(`  ${skips.length} need a person to decide`);

  for (const p of placements) {
    console.log(`    ${p.employeeCode} ${p.employeeName} → ${p.managerName}`);
  }
  if (skips.length > 0) {
    console.log("\n  Left alone:");
    for (const s of skips) console.log(`    ${s.employeeCode} ${s.employeeName} — ${s.reason}`);
  }

  totalPlaced += placements.length;
  totalSkipped += skips.length;
  totalAlready += already;

  if (apply && placements.length > 0) {
    // One transaction per organisation. A half-written chart is worse to reason
    // about than an unwritten one, and these are small.
    await prisma.$transaction(
      placements.map((p) =>
        prisma.reportingRelationship.create({
          data: {
            organizationId: org.id,
            employeeId: p.employeeId,
            managerId: p.managerId,
            type: "PRIMARY",
            startDate: new Date(`${TODAY}T00:00:00.000Z`),
          },
        }),
      ),
    );
    console.log(`\n  Wrote ${placements.length} line(s).`);
  }
}

console.log(
  `\n${totalAlready} already had a manager, ${totalPlaced} placeable, ${totalSkipped} need a decision.`,
);

if (!apply) {
  console.log("\nDry run. Nothing was written. Add --apply to write these lines.\n");
} else {
  console.log(
    "\nDone. The skipped people still route to HR and Admin — set their manager on the employee form.\n",
  );
}

await prisma.$disconnect();
