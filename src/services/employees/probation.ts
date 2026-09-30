import { prisma } from "@/lib/db/prisma";
import { notify } from "@/lib/notify";

/**
 * Whose probation or training ends this week.
 *
 * `confirmationDate` was written once at creation and read by nothing — no
 * screen, no letter, no report, no job. So a probation had an end date and
 * nobody was ever told it had arrived, which is the same as not having one.
 *
 * A notification rather than an automatic confirmation, deliberately.
 * Confirming somebody is a decision with a letter and a salary revision behind
 * it; a job that quietly flipped the state would make that decision invisible.
 *
 * Idempotent by date window rather than by a flag: it runs once a night and
 * looks at a seven-day window, so somebody due on Thursday is named on Monday
 * and again on Tuesday. That repetition is the point — it is a reminder.
 */
export const CONFIRMATION_NOTICE_DAYS = 7;

export async function flagUpcomingConfirmations(
  options: { withinDays?: number; now?: Date } = {},
): Promise<{ organizations: number; employees: number }> {
  const withinDays = options.withinDays ?? CONFIRMATION_NOTICE_DAYS;
  const now = options.now ?? new Date();

  const from = new Date(now);
  from.setUTCHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + withinDays);

  const due = await prisma.employee.findMany({
    where: {
      active: true,
      employmentState: { in: ["TRAINING", "PROBATION"] },
      confirmationDate: { gte: from, lte: to },
    },
    select: {
      id: true,
      organizationId: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      employmentState: true,
      confirmationDate: true,
    },
    orderBy: { confirmationDate: "asc" },
  });

  if (due.length === 0) return { organizations: 0, employees: 0 };

  const byOrg = new Map<string, typeof due>();
  for (const employee of due) {
    byOrg.set(employee.organizationId, [...(byOrg.get(employee.organizationId) ?? []), employee]);
  }

  for (const [organizationId, employees] of byOrg) {
    const names = employees
      .slice(0, 5)
      .map((e) => `${[e.firstName, e.lastName].filter(Boolean).join(" ")} (${e.employeeCode})`)
      .join(", ");
    const more = employees.length > 5 ? ` and ${employees.length - 5} more` : "";

    await notify.toOrgRoles(organizationId, ["HR_MANAGER", "ADMIN", "ORG_OWNER"], {
      type: "employee.confirmation_due",
      title:
        employees.length === 1
          ? "Somebody is due to be confirmed this week"
          : `${employees.length} people are due to be confirmed this week`,
      body: `${names}${more}. Confirming them is a state change on their profile.`,
      link: "/employees",
    });
  }

  return { organizations: byOrg.size, employees: due.length };
}
