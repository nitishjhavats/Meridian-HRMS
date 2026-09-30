/**
 * Round-13 smoke: "Mark anyway" on the phone actually marks, against the LOCAL
 * database and a running dev server.
 *
 *   npx tsx --env-file=.env scripts/smoke-mark-anyway.ts
 *
 * Signs in a seeded team member, gives the organisation a strict face policy
 * for the length of the run, posts a check-in that the face check must refuse
 * (a blank image, no reference photo on file), then posts the same with
 * `acceptForReview=true` and asserts a flagged day now exists. This is the
 * request the phone makes when the person presses the button; the route used
 * to drop the field on the floor. Everything it creates is removed at the end.
 *
 * Round 14 added three facts measured on the live instance, read back from
 * the database rather than the response:
 *
 *   - the check-in is sent with a ±400 m reading and is accepted, because the
 *     fence is radius-only unless the organisation switches the gate on (the
 *     35 m gate turned old phones away at the counter and recorded nothing);
 *   - the day it opens reads CHECKED_IN, not the HALF_DAY the missing-checkout
 *     rule used to stamp on it at once;
 *   - a check-out seconds later is refused with the guard's message and
 *     touches nothing -- and it is refused *before* the face check, which is
 *     why a blank photo with `acceptForReview` still gets a 409 and not a mark.
 */

import { prisma } from "@/lib/db/prisma";

const BASE = process.env.BASE ?? "http://localhost:3000";
const PASSWORD = process.env.SWEEP_PASSWORD ?? "Password@123";

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
}

/** A 64x64 grey JPEG: a photo with nothing in it, so the face check refuses it. */
function blankJpeg(): Blob {
  const b64 =
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCABAAEABAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA//9k=";
  return new Blob([Buffer.from(b64, "base64")], { type: "image/jpeg" });
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Refusing: DATABASE_URL is not local.");
  }

  const user = await prisma.user.findFirstOrThrow({
    where: { role: "TEAM_MEMBER", organization: { slug: "acme" }, employee: { isNot: null } },
    include: { employee: { select: { id: true, organizationId: true } } },
  });
  const employeeId = user.employee!.id;
  const orgId = user.employee!.organizationId;
  const since = new Date();

  const version = await prisma.orgPolicyVersion.findFirst({
    where: { organizationId: orgId, kind: "ATTENDANCE" },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
  });

  // The seed has no face block, so a mark is taken without one. For the length
  // of this run the organisation gets the strict policy -- a new version row,
  // removed at the end -- so the refusal and the escape are both exercised.
  const strict = await prisma.orgPolicyVersion.create({
    data: {
      organizationId: orgId,
      kind: "ATTENDANCE",
      version: (version?.version ?? 0) + 1000,
      payload: {
        ...((version?.payload as object) ?? {}),
        // The smoke runs at whatever hour it is run. A marking window that
        // refuses the mark before the face is ever looked at would test the
        // clock, not the escape.
        checkInWindow: { openMinutesBeforeStart: 1440, closeMinutesAfterEnd: 1440 },
        faceMatch: {
          mode: "REQUIRED",
          whenNotEnrolled: "BLOCK",
          requireBlink: false,
          onMismatch: "REVIEW",
          retriesBeforeReview: 2,
        },
      },
      effectiveFrom: new Date(new Date().toISOString().slice(0, 10)),
      note: "smoke-mark-anyway (temporary)",
    },
  });

  const cleanup = async () => {
    await prisma.orgPolicyVersion.delete({ where: { id: strict.id } }).catch(() => null);
    const events = await prisma.attendanceEvent.findMany({
      where: { employeeId, occurredAt: { gte: since } },
      select: { id: true, attendanceDayId: true },
    });
    for (const e of events) {
      await prisma.attendanceEvent.delete({ where: { id: e.id } }).catch(() => null);
      if (e.attendanceDayId) {
        await prisma.attendanceDay.delete({ where: { id: e.attendanceDayId } }).catch(() => null);
      }
    }
  };

  try {
    const location = await prisma.workLocation.findFirst({
      where: { organizationId: orgId },
      select: { latitude: true, longitude: true },
    });

    await prisma.rateLimitCounter.deleteMany({});
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? [])
      .find((c) => c.startsWith("hrms_session="))
      ?.split(";")[0];
    assert(cookie, `signed in as ${user.email}`);

    const hasFence = location?.latitude != null && location.longitude != null;
    // Worse than any ceiling the gate ever had (35 m) and well inside a 150 m
    // fence: the reading an old phone gives at the counter. Radius-only means
    // it is accepted and written on the mark, not turned away.
    const ACCURACY = 400;

    const post = async (type: "CHECK_IN" | "CHECK_OUT", acceptForReview: boolean) => {
      const form = new FormData();
      form.set("type", type);
      if (hasFence) {
        form.set("latitude", String(location.latitude));
        form.set("longitude", String(location.longitude));
        form.set("accuracyMeters", String(ACCURACY));
      }
      form.set("selfie", blankJpeg(), "selfie.jpg");
      if (acceptForReview) form.set("acceptForReview", "true");
      const r = await fetch(`${BASE}/api/attendance/mark`, {
        method: "POST",
        headers: { cookie },
        body: form,
      });
      const body = (await r.json().catch(() => null)) as {
        error?: { message?: string; details?: { face?: string; reviewAfterAttempts?: number | null } };
      } | null;
      return { status: r.status, body };
    };

    const first = await post("CHECK_IN", false);
    console.log("  first:", first.status, JSON.stringify(first.body?.error ?? first.body).slice(0, 200));
    // The fence is checked before the face. A face reason here means the
    // ±400 m reading went through the fence.
    assert(
      first.status === 422 && first.body?.error?.details?.face,
      hasFence
        ? `a blank photo at ±${ACCURACY} m inside the radius is refused for its face, not its fix (gpsAccuracy off)`
        : "a blank photo is refused with a face reason",
    );
    assert(
      first.body.error?.details?.reviewAfterAttempts != null,
      `the refusal offers a way out (reviewAfterAttempts=${first.body.error?.details?.reviewAfterAttempts})`,
    );

    const second = await post("CHECK_IN", true);
    console.log("  second:", second.status, JSON.stringify(second.body).slice(0, 200));
    assert(second.status === 200, "the same photo with acceptForReview=true is taken");

    const after = await prisma.attendanceEvent.findFirst({
      where: { employeeId, occurredAt: { gte: since }, attendanceDayId: { not: null } },
      orderBy: { occurredAt: "desc" },
    });
    assert(after && after.flaggedForReview, "a flagged event with a day behind it now exists");
    if (hasFence) {
      assert(after.accuracyMeters === ACCURACY, `the rough reading is recorded on the mark (accuracyMeters=${after.accuracyMeters})`);
      assert(after.withinGeofence, "and the fence passed on distance alone");
    }

    const open = await prisma.attendanceDay.findUniqueOrThrow({
      where: { id: after.attendanceDayId! },
      select: { status: true, systemStatus: true, lastCheckOutAt: true },
    });
    assert(
      open.status === "CHECKED_IN" && open.systemStatus === "CHECKED_IN",
      `the open day reads CHECKED_IN (status=${open.status}, systemStatus=${open.systemStatus})`,
    );

    // The same blank photo, the same escape, seconds later: the guard answers
    // before the face check does, so this is a 409 and not a flagged check-out.
    const out = await post("CHECK_OUT", true);
    console.log("  check-out:", out.status, JSON.stringify(out.body?.error ?? out.body).slice(0, 200));
    assert(
      out.status === 409 && /You checked in (less than a minute|\d+ minutes?) ago\. Check out when you leave\./.test(out.body?.error?.message ?? ""),
      "a check-out straight after the check-in is refused with the guard's message",
    );
    assert(out.body?.error?.details?.face == null, "and it is the guard refusing, not the face check");

    const still = await prisma.attendanceDay.findUniqueOrThrow({
      where: { id: after.attendanceDayId! },
      select: { status: true, lastCheckOutAt: true },
    });
    assert(still.status === "CHECKED_IN" && still.lastCheckOutAt === null, "the day is untouched by the refusal");
    const checkOuts = await prisma.attendanceEvent.count({
      where: { employeeId, occurredAt: { gte: since }, type: "CHECK_OUT" },
    });
    assert(checkOuts === 0, "and no check-out event was written");
    console.log("\nAll good.");
  } finally {
    await cleanup();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
