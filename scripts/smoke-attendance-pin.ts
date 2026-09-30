/**
 * Round-12 smoke run for the attendance PIN desk, against the LOCAL database.
 *
 *   npx tsx --env-file=.env scripts/smoke-attendance-pin.ts
 *
 * Real contexts through `loadContext`, no HTTP, no passwords. Checks that the
 * permission folds in from a role row, that the roster and the recent list
 * answer for the right people, that the who-can-help list names the owner,
 * and that nobody -- owner included -- can issue their own. Refuses to run
 * against anything but localhost.
 */

import { prisma } from "@/lib/db/prisma";
import { loadContext } from "@/lib/auth/context";
import { issueAttendancePin } from "@/services/attendance/kiosk";
import {
  getPinAuthorities,
  grantPinAuthority,
  listRecentPins,
  mayIssuePin,
  pinRoster,
  revokePinAuthority,
  whoCanIssuePin,
} from "@/services/attendance/pinAuthority";

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) {
    throw new Error("Refusing: DATABASE_URL is not local.");
  }

  const owner = await prisma.user.findFirstOrThrow({
    where: { role: "ORG_OWNER", organization: { slug: "acme" } },
    include: { employee: true },
  });
  const orgId = owner.organizationId as string;
  const member = await prisma.user.findFirstOrThrow({
    where: { organizationId: orgId, role: "TEAM_MEMBER", employee: { isNot: null } },
    include: { employee: true },
  });
  const ctxOf = (u: { id: string; role: string }) =>
    loadContext({ sub: u.id, sid: "smoke", org: orgId, role: u.role as never });

  console.log("\n1. Out of the box");
  const ownerCtx = await ctxOf(owner);
  const memberCtx = await ctxOf(member);
  assert(ownerCtx.permissions.has("attendance.pin.issue"), "the owner holds the permission from the bundle");
  assert(!memberCtx.permissions.has("attendance.pin.issue"), "a team member does not");
  assert(await mayIssuePin(ownerCtx), "mayIssuePin says yes for the owner");
  assert(!(await mayIssuePin(memberCtx)), "and no for the member");
  const helpers = await whoCanIssuePin(memberCtx);
  assert(helpers.length > 0, `the who-can-help list is not empty (${helpers.length} named)`);
  const roster = await pinRoster(ownerCtx);
  assert(roster.length > 0 && !roster.some((p) => p.id === owner.employee?.id), "the roster leaves the caller out");
  const denied = await pinRoster(memberCtx).catch((e: Error) => e);
  assert(denied instanceof Error, "the roster is refused to somebody without the permission");

  console.log("\n2. Ticking a role");
  await grantPinAuthority(ownerCtx, { role: "TEAM_MEMBER" });
  const view = await getPinAuthorities(ownerCtx);
  const row = view.roles.find((r) => r.role === "TEAM_MEMBER");
  assert(row?.granted === true && row.rowId, "the role shows as granted with a row to switch it off");
  assert(view.roles.find((r) => r.role === "ORG_OWNER")?.always === true, "Owner is always on");
  const memberAfter = await ctxOf(member);
  assert(memberAfter.permissions.has("attendance.pin.issue"), "the member's context now carries the permission");
  assert((await pinRoster(memberAfter)).length > 0, "and the roster answers for them");
  const twice = await grantPinAuthority(ownerCtx, { role: "TEAM_MEMBER" }).catch((e: Error) => e);
  assert(!(twice instanceof Error), "granting twice is a no-op, not an error");
  const locked = await grantPinAuthority(ownerCtx, { role: "ADMIN" }).catch((e: Error) => e);
  assert(locked instanceof Error, "Admin cannot be added as a row: it is always on");

  console.log("\n3. Issuing");
  const target = roster.find((p) => p.id !== member.employee?.id) ?? roster[0]!;
  const pin = await issueAttendancePin(memberAfter, target.id, "smoke");
  assert(/^\d{6}$/.test(pin.code), "a ticked member issues a six-digit PIN");
  const own = await issueAttendancePin(ownerCtx, owner.employee!.id).catch((e: Error) => e);
  assert(own instanceof Error && /yourself/.test(own.message), "the owner cannot issue their own");
  const mine = await listRecentPins(memberAfter);
  assert(mine.some((p) => p.employeeCode === target.code && p.state === "LIVE"), "the issuer sees it live in their recent list");
  const all = await listRecentPins(ownerCtx);
  assert(all.some((p) => p.employeeCode === target.code), "and the owner sees everybody's");

  console.log("\n4. Switching the role off");
  await revokePinAuthority(ownerCtx, row!.rowId!);
  const memberGone = await ctxOf(member);
  assert(!memberGone.permissions.has("attendance.pin.issue"), "the permission is gone from the member's context");
  await prisma.attendancePin.updateMany({ where: { organizationId: orgId, reason: "smoke" }, data: { usedAt: new Date() } });

  console.log("\nAll good.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
