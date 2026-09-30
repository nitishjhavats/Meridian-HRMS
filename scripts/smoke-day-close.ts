/**
 * The close of the day, exercised end to end on the local seed database.
 *
 *   npm run smoke:day-close
 *
 * Seeds nothing permanent: picks an organisation from the seed, arranges a
 * no-show, an open check-in, an overridden row and a no-show on approved
 * leave on a working day inside the lookback, runs the close, reads every
 * assertion back from the database, and removes what it made. Refuses to run
 * against anything but a local database.
 */

import { prisma } from "@/lib/db/prisma";
import { closeAttendanceDays } from "@/services/attendance/dayClose";
import { NO_CHECK_IN_REMARK, NO_CHECK_OUT_REMARK, isOnRoll } from "@/domain/attendance/dayClose";
import { buildPeriodCalendar } from "@/domain/calendar";
import { resolveWeeklyOff } from "@/services/org/weeklyOff";
import { addDays, todayInZone, zonedTimeToInstant } from "@/domain/date";
import { getAttendanceRulesForOrganization } from "@/services/policy";
import { settleOpenDay } from "@/domain/attendance/policy";

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Refusing: DATABASE_URL is not local.");
  }

  const org = await prisma.organization.findUniqueOrThrow({
    where: { slug: "acme" },
    select: { id: true, timezone: true },
  });
  const now = new Date();
  const today = todayInZone(org.timezone, now);
  const rules = await getAttendanceRulesForOrganization(org.id, today);

  // Four people on the roll, one for each case.
  const employees = await prisma.employee.findMany({
    where: { organizationId: org.id, active: true, employmentState: { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] } },
    select: {
      id: true,
      employeeCode: true,
      departmentId: true,
      joiningDate: true,
      exitDate: true,
      weeklyOffConfig: true,
      weeklyOffPattern: { select: { config: true } },
    },
    orderBy: { employeeCode: "asc" },
    take: 4,
  });
  assert(employees.length === 4, "four active employees to test with");
  const [noShow, open, overridden, onLeave] = employees as [
    (typeof employees)[0],
    (typeof employees)[0],
    (typeof employees)[0],
    (typeof employees)[0],
  ];
  const leaveType = await prisma.leaveType.findFirst({
    where: { organizationId: org.id },
    select: { id: true },
  });
  assert(leaveType, "a leave type to approve leave against");

  // The most recent working day inside the lookback for the no-show, with no
  // row of their own -- yesterday or earlier, and one whose window has closed.
  const weeklyOff = await resolveWeeklyOff(prisma, org.id, noShow);
  const calendar = buildPeriodCalendar(
    addDays(today, -6),
    addDays(today, -1),
    { employeeId: noShow.id, departmentId: noShow.departmentId, weeklyOff },
    [],
  );
  const roll = {
    joiningDate: noShow.joiningDate.toISOString().slice(0, 10),
    exitDate: noShow.exitDate ? noShow.exitDate.toISOString().slice(0, 10) : null,
  };
  const candidates = calendar.days.filter((d) => d.kind === "WORKING" && isOnRoll(roll, d.date)).map((d) => d.date);
  let date: string | null = null;
  for (const d of [...candidates].reverse()) {
    const taken = await prisma.attendanceDay.count({
      where: { employeeId: { in: employees.map((e) => e.id) }, date: new Date(`${d}T00:00:00.000Z`) },
    });
    if (taken === 0) {
      date = d;
      break;
    }
  }
  assert(date, "a recent working day with no rows for the four");
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const checkInAt = zonedTimeToInstant(date, 9 * 60 + 5, org.timezone);

  const made: string[] = [];
  const leaves: string[] = [];
  const cleanup = async () => {
    // Everything the close wrote for the organisation during this run: the
    // seed has many people with no marks in the last week, and all of their
    // absences were real rows a moment ago.
    await prisma.attendanceDay.deleteMany({
      where: {
        OR: [
          { id: { in: made } },
          { organizationId: org.id, source: "SYSTEM", createdAt: { gte: now } },
        ],
      },
    });
    await prisma.leaveRequest.deleteMany({ where: { id: { in: leaves } } });
    await prisma.auditLog.deleteMany({
      where: { organizationId: org.id, action: "attendance.day_closed", createdAt: { gte: now } },
    });
  };

  try {
    // Approved leave with no attendance row of its own: the close must leave
    // the day blank for payroll's leave net, not write ABSENT over it.
    const leave = await prisma.leaveRequest.create({
      data: {
        organizationId: org.id,
        employeeId: onLeave.id,
        leaveTypeId: leaveType.id,
        startDate: dayStart,
        endDate: dayStart,
        totalDays: 1,
        reason: "smoke",
        status: "APPROVED",
      },
      select: { id: true },
    });
    leaves.push(leave.id);

    // An open check-in, and an overridden open check-in that must be left alone.
    for (const [who, override] of [
      [open, false],
      [overridden, true],
    ] as const) {
      const row = await prisma.attendanceDay.create({
        data: {
          organizationId: org.id,
          employeeId: who.id,
          date: dayStart,
          status: override ? "FULL_DAY" : "CHECKED_IN",
          systemStatus: "CHECKED_IN",
          firstCheckInAt: checkInAt,
          source: "SELF_GPS",
          ...(override ? { overriddenAt: now, overrideReason: "smoke" } : {}),
        },
      });
      made.push(row.id);
    }

    // 1. Dry run plans, writes nothing.
    // `from`: the seed's recent days may sit before DAY_CLOSE_EPOCH, and an
    // explicit start is how the operator reaches them too.
    const plan = await closeAttendanceDays({ now, from: date, lookbackDays: 30, organizationId: org.id, dryRun: true });
    const planned = plan.perOrg[0]!.planned.filter((p) => p.date === date);
    assert(plan.perOrg[0]!.dates.includes(date), `the day ${date} is old enough to close`);
    assert(
      planned.some((p) => p.employeeCode === noShow.employeeCode && p.change === "ABSENT"),
      "dry run lists the no-show as ABSENT",
    );
    assert(
      planned.some((p) => p.employeeCode === open.employeeCode && p.change.startsWith("CHECKED_IN")),
      "dry run lists the open check-in for settling",
    );
    assert(
      !planned.some((p) => p.employeeCode === overridden.employeeCode),
      "dry run leaves the overridden row alone",
    );
    assert(
      !planned.some((p) => p.employeeCode === onLeave.employeeCode) &&
        plan.perOrg[0]!.skipped.some(
          (s) => s.employeeCode === onLeave.employeeCode && s.date === date && s.reason === "ON_LEAVE",
        ),
      "dry run lists the person on approved leave as left blank, not as ABSENT",
    );
    const beforeWrite = await prisma.attendanceDay.count({ where: { employeeId: noShow.id, date: dayStart } });
    assert(beforeWrite === 0, "dry run wrote nothing");

    // 2. The real run writes both, once.
    const first = await closeAttendanceDays({ now, from: date, lookbackDays: 30, organizationId: org.id });
    const absent = await prisma.attendanceDay.findUnique({
      where: { employeeId_date: { employeeId: noShow.id, date: dayStart } },
    });
    assert(absent && absent.status === "ABSENT" && absent.systemStatus === "ABSENT", "the no-show has an ABSENT row");
    assert(absent.source === "SYSTEM" && absent.remarks === NO_CHECK_IN_REMARK, "written by the system, with the remark");

    const settled = await prisma.attendanceDay.findUnique({
      where: { employeeId_date: { employeeId: open.id, date: dayStart } },
    });
    const expected = settleOpenDay("CHECKED_IN", rules.missingCheckout);
    assert(settled?.status === expected, `the open check-in settled to ${expected} (missingCheckout ${rules.missingCheckout})`);
    assert(settled.remarks === NO_CHECK_OUT_REMARK && settled.lastCheckOutAt === null, "with the remark and still no check-out");

    const untouched = await prisma.attendanceDay.findUnique({
      where: { employeeId_date: { employeeId: overridden.id, date: dayStart } },
    });
    assert(untouched?.status === "FULL_DAY" && untouched.systemStatus === "CHECKED_IN", "the overridden row is untouched");
    const leaveRow = await prisma.attendanceDay.count({ where: { employeeId: onLeave.id, date: dayStart } });
    assert(leaveRow === 0 && first.leaveWithoutRow >= 1, "the person on approved leave has no row, and is counted");
    assert(first.absentCreated >= 1 && first.openDaysClosed === 1, `counts reported (${first.absentCreated} absent, ${first.openDaysClosed} settled)`);

    const audit = await prisma.auditLog.count({
      where: { organizationId: org.id, action: "attendance.day_closed", createdAt: { gte: now } },
    });
    assert(audit === 1, "one audit line for the organisation");

    // 3. A second run is a no-op.
    const again = await closeAttendanceDays({ now, from: date, lookbackDays: 30, organizationId: org.id });
    assert(again.absentCreated === 0 && again.openDaysClosed === 0, "a second run writes nothing");
    const auditAgain = await prisma.auditLog.count({
      where: { organizationId: org.id, action: "attendance.day_closed", createdAt: { gte: now } },
    });
    assert(auditAgain === 1, "and adds no audit line");

    // 4. Today is not closed while its window is open (the seed shift ends in
    //    the evening; if this runs after 23:00 local the assertion is skipped).
    const todayRows = await prisma.attendanceDay.count({
      where: { organizationId: org.id, date: new Date(`${today}T00:00:00.000Z`), source: "SYSTEM" },
    });
    if (!plan.perOrg[0]!.dates.includes(today)) assert(todayRows === 0, "today is left open");
    else console.log("  --  today's window has closed already; skipped the open-day check");

    console.log("\nsmoke:day-close passed\n");
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
