/**
 * Moves existing organisations onto the 150 m default, and switches the
 * geofence on where it is safe to.
 *
 *   npm run fence:default                       # every organisation, dry run
 *   npm run fence:default -- --org=acme         # one organisation
 *   npm run fence:default -- --apply            # writes
 *   npm run fence:default -- --apply --force    # enable even where people are unassigned
 *
 * **Why this exists.** Two defaults changed in code, and a default only reaches
 * rows nothing has written yet.
 *
 *   1. `WorkLocation.radiusMeters` now defaults to 150. Locations created
 *      before this keep the 100 they were given.
 *   2. `requireWorkLocation` now defaults to `true`. An organisation whose
 *      attendance policy row was written earlier still carries `false`, and
 *      with it the hole that made this round necessary: `requireGps` forced
 *      coordinates to be *present* and, for anybody without a work location,
 *      nothing ever compared them to anywhere.
 *
 * **What it will not do.** It will not switch the fence on for an organisation
 * where an active employee has no work location assigned, because that refuses
 * that person their attendance the next morning. Those organisations are
 * printed with the names, so somebody can assign locations and re-run. `--force`
 * overrides, and says so loudly.
 *
 * **The radius is only moved where it was still the old default.** A location
 * someone deliberately set to 100 m is indistinguishable from one that took the
 * old default -- so this is the one judgement call in the script, and it is
 * made in favour of the organisation's stated intent being the *policy*
 * default, not a hand-typed 100. Anything other than 100 is left alone.
 *
 * Safe to re-run.
 */
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const orgArg = process.argv.find((a) => a.startsWith("--org="))?.slice("--org=".length);

const OLD_DEFAULT_RADIUS = 100;
const NEW_DEFAULT_RADIUS = 150;
const ACTIVE_STATES = { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] } as const;

const organizations = await prisma.organization.findMany({
  where: orgArg ? { slug: orgArg } : {},
  select: { id: true, name: true, slug: true },
  orderBy: { name: "asc" },
});

if (organizations.length === 0) {
  console.log(orgArg ? `No organisation with slug "${orgArg}".` : "No organisations.");
  await prisma.$disconnect();
  process.exit(1);
}

let widened = 0;
let enabled = 0;
let heldBack = 0;
let facesEnforced = 0;

for (const org of organizations) {
  console.log(`\n${org.name} (${org.slug})`);

  // ---- radius
  const narrow = await prisma.workLocation.findMany({
    where: { organizationId: org.id, radiusMeters: OLD_DEFAULT_RADIUS },
    select: { id: true, name: true },
  });
  if (narrow.length === 0) {
    console.log("  radius: nothing on the old default.");
  } else {
    console.log(
      `  radius: ${narrow.length} location(s) at ${OLD_DEFAULT_RADIUS} m -> ${NEW_DEFAULT_RADIUS} m`,
    );
    for (const l of narrow) console.log(`    ${l.name}`);
    if (apply) {
      await prisma.workLocation.updateMany({
        where: { organizationId: org.id, radiusMeters: OLD_DEFAULT_RADIUS },
        data: { radiusMeters: NEW_DEFAULT_RADIUS },
      });
    }
    widened += narrow.length;
  }

  // ---- the fence itself
  // The newest active version is the one `getAttendanceRules` reads, and it
  // merges over the code defaults -- so a payload written before this change
  // still carries `requireWorkLocation: false` and still wins.
  const row = await prisma.orgPolicyVersion.findFirst({
    where: { organizationId: org.id, kind: "ATTENDANCE", active: true },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    select: { id: true, payload: true },
  });
  if (!row) {
    console.log("  fence: no attendance policy row; the code default already applies.");
    continue;
  }

  const stored = (row.payload ?? {}) as Record<string, unknown>;
  if (stored.requireWorkLocation === true) {
    console.log("  fence: already enforced.");
    continue;
  }

  // Who would be locked out on Monday.
  const unassigned = await prisma.employee.findMany({
    where: {
      organizationId: org.id,
      active: true,
      employmentState: ACTIVE_STATES,
      OR: [{ workLocationId: null }, { workLocation: { active: false } }],
    },
    select: { employeeCode: true, firstName: true, lastName: true },
    orderBy: { employeeCode: "asc" },
  });

  if (unassigned.length > 0 && !force) {
    heldBack += 1;
    console.log(
      `  fence: NOT enabled — ${unassigned.length} active employee(s) have no work location:`,
    );
    for (const e of unassigned) {
      console.log(`    ${e.employeeCode} ${[e.firstName, e.lastName].filter(Boolean).join(" ")}`);
    }
    console.log("    Assign them a work location and re-run, or pass --force.");
    continue;
  }

  if (unassigned.length > 0) {
    console.log(
      `  fence: enabling with --force; ${unassigned.length} employee(s) will be refused until assigned.`,
    );
  } else {
    console.log("  fence: enabling — every active employee has a work location.");
  }

  enabled += 1;

  /**
   * And face matching, on the same terms.
   *
   * A stored policy carries no `faceMatch` block at all -- none of them ever
   * did -- and an absent block is read as the old permissive behaviour, on
   * purpose: tightening the shipped default would otherwise have refused every
   * unenrolled employee on the deploy that shipped it.
   *
   * So it is written here, and only where nobody is locked out by it. The
   * check is the same shape as the work-location one above, and for the same
   * reason: this decides whether somebody can mark their attendance tomorrow
   * morning.
   */
  const unenrolled = await prisma.employee.findMany({
    where: {
      organizationId: org.id,
      active: true,
      employmentState: ACTIVE_STATES,
      faceEnrolledAt: null,
    },
    select: { employeeCode: true, firstName: true, lastName: true },
    orderBy: { employeeCode: "asc" },
  });

  const strictFaces = unenrolled.length === 0 || force;
  if (!strictFaces) {
    console.log(
      `  faces: NOT enforced — ${unenrolled.length} active employee(s) have no reference photo:`,
    );
    for (const e of unenrolled.slice(0, 10)) {
      console.log(`    ${e.employeeCode} ${[e.firstName, e.lastName].filter(Boolean).join(" ")}`);
    }
    if (unenrolled.length > 10) console.log(`    …and ${unenrolled.length - 10} more`);
    console.log("    Enrol them and re-run, or pass --force.");
  } else if (unenrolled.length > 0) {
    console.log(
      `  faces: enforcing with --force; ${unenrolled.length} employee(s) cannot use the face path until enrolled.`,
    );
    console.log(
      "    They are not stranded: a PIN from somebody on the PIN authority list marks the day, recorded as unverified.",
    );
    facesEnforced += 1;
  } else {
    console.log("  faces: enforcing — every active employee has a reference photo.");
    facesEnforced += 1;
  }

  if (apply) {
    // One or two keys, edited in place on the active version. Cutting a new
    // version would be the tidier story, but it would also re-date the whole
    // policy and make unrelated settings look like they changed today.
    await prisma.orgPolicyVersion.update({
      where: { id: row.id },
      data: {
        payload: {
          ...stored,
          requireWorkLocation: true,
          ...(strictFaces
            ? {
                faceMatch: {
                  mode: "REQUIRED",
                  threshold: 0.363,
                  minDetectionScore: 0.7,
                  whenNotEnrolled: "BLOCK",
                  rejectMultipleFaces: true,
                  requireBlink: true,
                },
              }
            : {}),
        } as Prisma.InputJsonValue,
      },
    });
  }
}

console.log(
  `\n${widened} location(s) widened, ${enabled} organisation(s) fencing, ` +
    `${facesEnforced} enforcing face matching, ${heldBack} held back.`,
);

if (!apply) {
  console.log("\nDry run. Nothing was written. Add --apply to write.\n");
} else {
  console.log("\nDone.\n");
}

await prisma.$disconnect();
