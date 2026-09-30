import { prisma } from "@/lib/db/prisma";
import { getAttendanceRules } from "@/services/policy";
import type { AuthContext } from "@/lib/auth/context";
import { hasPermission, requireOrg } from "@/lib/auth/guard";

/**
 * What is still missing before this organisation can actually be used.
 *
 * Self-signup is open, so an organisation can now exist thirty seconds after
 * somebody typed their name into a form — with no work location, no attendance
 * rules, no employees and no way to mark attendance. Everything needed is
 * reachable from the settings hub, and nothing tells a new owner which of the
 * fourteen cards there they are supposed to open first. They find out by
 * discovering that attendance does not work.
 *
 * So this reports the handful of facts that have to be true, each with the one
 * screen that makes it true. Deliberately short: a checklist that lists
 * everything is a second settings hub, and gets ignored the same way.
 *
 * Attendance rules are deliberately not on it. Provisioning writes a default
 * `OrgPolicyVersion` for every organisation, so the step would be green from
 * the first second and could never go back — and a checklist line that can
 * only ever be ticked teaches people to stop reading the list.
 *
 * **There is no dismiss.** A dismissed checklist is a column, a migration and
 * a decision about whether "dismissed" survives somebody else finishing the
 * work. This one disappears when the last item is done, which is the only
 * moment it should — and it comes back if somebody deactivates their last work
 * location, which is exactly when it is worth seeing again.
 */

export interface SetupStep {
  key: string;
  title: string;
  /** Why it matters, in terms of what stops working without it. */
  why: string;
  href: string;
  done: boolean;
}

export interface SetupState {
  steps: SetupStep[];
  remaining: number;
}

/**
 * Only for somebody who can act on it.
 *
 * A team member cannot add a work location, so showing them a list of things
 * their administrator has not done is noise on the screen they use every day.
 * The gate is `org.settings.write`, which is the permission every step's
 * destination actually requires.
 */
export async function getSetupState(ctx: AuthContext): Promise<SetupState | null> {
  requireOrg(ctx);
  if (!hasPermission(ctx, "org.settings.write")) return null;

  const orgId = ctx.organizationId!;
  const org = { organizationId: orgId, active: true };

  const [locations, employees, unassigned, devices, organization, attendance] = await Promise.all([
    prisma.workLocation.count({ where: org }),
    prisma.employee.count({ where: { organizationId: orgId, active: true } }),
    // People the geofence cannot measure. What that costs them depends on the
    // organisation's own `requireWorkLocation`: with it on they are refused at
    // the door, with it off they are waved through from anywhere. Two of the
    // three organisations here have it off, so the copy below asks.
    prisma.employee.count({
      where: {
        organizationId: orgId,
        active: true,
        employmentState: { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] },
        OR: [{ workLocationId: null }, { workLocation: { active: false } }],
      },
    }),
    // A revoked device is not a device — the same predicate the devices panel
    // lists by.
    prisma.kioskDevice.count({ where: { organizationId: orgId, revokedAt: null } }),
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { addressLine1: true, city: true },
    }),
    getAttendanceRules(ctx),
  ]);

  /**
   * Whether this organisation refuses a mark from somebody with no branch.
   *
   * Two of the three organisations on this instance have it **off**, which
   * is why the sentences below cannot be constants: on one of them a person
   * with no branch is turned away at the door, and on the other two the same
   * person marks attendance from wherever they are standing.
   */
  const requireWorkLocation = attendance.requireWorkLocation;

  const steps: SetupStep[] = [
    {
      key: "address",
      title: "Fill in your organisation's address",
      why: "It prints on every letter and payslip. Without it the letterhead carries a name and nothing else.",
      href: "/settings/organisation",
      done: Boolean(organization?.addressLine1 && organization.city),
    },
    {
      key: "location",
      title: "Add a work location",
      /**
       * Which sentence is true depends on the organisation's own rule.
       *
       * With `requireWorkLocation` on, `checkIn` refuses somebody who has no
       * branch — nobody can mark, which is a locked door. With it off, the
       * fence is never evaluated at all and attendance can be marked from any
       * address in the world. Those are opposite outcomes and this step used to
       * assert the first one flatly, which on an organisation with the rule off
       * told an administrator they were safe while everybody marked from home.
       */
      why: requireWorkLocation
        ? "Attendance is checked against a location's geofence. Nobody can mark attendance until there is one."
        : "Attendance is not checked against anywhere until there is one — it can be marked from any address in the world, and nothing on the record says so.",
      href: "/settings/attendance",
      done: locations > 0,
    },
    {
      key: "employees",
      title: "Add your employees",
      why: "One at a time, or a CSV. Everything else in the product is about them.",
      href: "/employees",
      done: employees > 0,
    },
    {
      key: "assign-location",
      title: "Give every employee a work location",
      // Same fork. New people get the primary branch automatically now, on the
      // form and through the importer alike; this step is for the ones created
      // before that, and for anyone whose branch was switched off.
      why:
        unassigned === 0
          ? "Attendance is measured against the location each person is assigned to."
          : requireWorkLocation
            ? `${unassigned} ${unassigned === 1 ? "person has" : "people have"} no work location, so their attendance will be refused until one is set.`
            : `${unassigned} ${unassigned === 1 ? "person can" : "people can"} mark attendance from any address in the world, because no branch is set and no distance is measured.`,
      href: "/employees",
      // Nobody to assign yet is not a failure -- it would make the list start
      // red on an empty organisation, before the step it depends on.
      done: employees === 0 || unassigned === 0,
    },
    {
      key: "device",
      title: "Set up an office device",
      why: "A shared screen in reception people mark attendance on, instead of each person using their own phone. Optional, but the usual way an office runs it.",
      href: "/settings/attendance#devices",
      done: devices > 0,
    },
  ];

  return { steps, remaining: steps.filter((s) => !s.done).length };
}
