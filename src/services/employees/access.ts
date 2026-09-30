import type { Prisma } from "@prisma/client";

/**
 * Turning an employee's login on and off as they arrive and leave.
 *
 * Extracted because it was written once, in `changeEmploymentState`, and the
 * path offboarding actually takes is a different one. Settling an exit
 * deactivated the employee and never touched the `User`, so somebody whose
 * full-and-final settlement was complete still had a working password and a
 * live session — and could sign in and download whatever their role allowed on
 * their way out the door.
 *
 * That was impossible before employees had logins at all. Giving them logins
 * created it, which is why this now lives in one place that both paths call
 * rather than in one path that happens to be the less-used one.
 *
 * `loadContext` already refuses a `DISABLED` user, so a live session would stop
 * at its next request anyway. Revoking makes it immediate, and makes the
 * sessions list say what happened.
 */
export async function setEmployeeLoginActive(
  tx: Prisma.TransactionClient,
  employee: { userId: string | null },
  options: { active: boolean; actorId: string },
): Promise<void> {
  if (!employee.userId) return;

  if (!options.active) {
    await tx.user.update({ where: { id: employee.userId }, data: { status: "DISABLED" } });
    await tx.session.updateMany({
      where: { userId: employee.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: options.actorId },
    });
    return;
  }

  // Coming back — a rescinded resignation, or a rehire on the same record.
  // `updateMany` with the status in the filter so this only ever reverses a
  // disable, and never quietly reactivates somebody an administrator suspended
  // for a different reason.
  await tx.user.updateMany({
    where: { id: employee.userId, status: "DISABLED" },
    data: { status: "ACTIVE" },
  });
}
