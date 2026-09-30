import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireAnyPermission, requireOrg } from "@/lib/auth/guard";
import {
  DEFAULT_WEEKLY_OFF,
  describeWeeklyOff,
  readPersonalWeeklyOff,
  type WeeklyOffConfig,
} from "@/domain/calendar/weeklyOff";

/**
 * Which days this person does not work.
 *
 * The employee form offers "Organisation default" for the weekly-off pattern,
 * and picking it writes `weeklyOffPatternId: null`. `WeeklyOffPattern.isDefault`
 * is written when an organisation is provisioned and was **read by nothing** —
 * so "organisation default" did not mean the organisation's default. It meant
 * three different things:
 *
 *  - payroll fell back to the hard-coded `DEFAULT_WEEKLY_OFF`, Sunday only;
 *  - attendance did the same;
 *  - leave counted **no** week-off at all, because its `if (pattern)` guard
 *    left the set empty.
 *
 * So for anybody on "organisation default", a leave request spanning a Sunday
 * deducted a day of leave that payroll then treated as a rest day. An
 * organisation whose default is "Sunday and alternate Saturday" had every
 * unassigned employee silently paid, marked and accrued as Sunday-only.
 *
 * One resolver, four callers. The order is: the person's own days, then the
 * employee's named pattern, then the organisation's default row, then the
 * shipped constant — which now only applies to an organisation that has no
 * default pattern at all.
 *
 * The person's own days come first because that is the only reason they
 * exist: "everybody is off on Sunday except the guard, who is off on Tuesday"
 * was not expressible without a one-person pattern per exception. They are
 * read through `readPersonalWeeklyOff`, which refuses anything but a well-formed
 * FIXED or MULTIPLE — a malformed column must fall through, not turn every day
 * into a working day.
 */

/** The two columns on the employee that say when they rest. Selected by every caller. */
export interface WeeklyOffSource {
  /** `Employee.weeklyOffConfig` — their own days, or null for "as the pattern says". */
  weeklyOffConfig: unknown;
  /** The named pattern they are on, when they are on one. */
  weeklyOffPattern?: { config: unknown } | null;
}

export async function resolveWeeklyOff(
  db: Pick<Prisma.TransactionClient, "weeklyOffPattern">,
  organizationId: string,
  employee: WeeklyOffSource | null | undefined,
): Promise<WeeklyOffConfig> {
  const personal = readPersonalWeeklyOff(employee?.weeklyOffConfig);
  if (personal) return personal;

  const pattern = employee?.weeklyOffPattern?.config;
  if (pattern) return pattern as WeeklyOffConfig;

  return organisationWeeklyOff(db, organizationId);
}

/** The organisation's default pattern, or the shipped Sunday when it has none. */
export async function organisationWeeklyOff(
  db: Pick<Prisma.TransactionClient, "weeklyOffPattern">,
  organizationId: string,
): Promise<WeeklyOffConfig> {
  const fallback = await db.weeklyOffPattern.findFirst({
    where: { organizationId, isDefault: true, active: true },
    select: { config: true },
  });

  return (fallback?.config as WeeklyOffConfig | null) ?? DEFAULT_WEEKLY_OFF;
}

export interface WeeklyOffChoices {
  /** What "same as organisation" resolves to, described for a label. */
  organisationDefault: WeeklyOffConfig;
  organisationDefaultSummary: string;
  /** The named patterns somebody can be put on, with what each one says. */
  patterns: { id: string; name: string; summary: string; active: boolean }[];
}

/**
 * What the Week off card on a profile can offer.
 *
 * Guarded on seeing employee records rather than on editing them: the card
 * is read by everybody who can open the profile, and the honest label for
 * "Organisation default" is the organisation's actual default, which this is
 * the only way to learn without a Prisma call from the page.
 */
export async function weeklyOffChoices(ctx: AuthContext): Promise<WeeklyOffChoices> {
  requireOrg(ctx);
  requireAnyPermission(ctx, ["employee.read.all", "employee.read.team"]);

  const [organisationDefault, patterns] = await Promise.all([
    organisationWeeklyOff(prisma, ctx.organizationId),
    // Inactive patterns come too: somebody put on one before it was switched
    // off is still on it, and the card must say so rather than call it the
    // organisation default. They are offered greyed, not hidden.
    prisma.weeklyOffPattern.findMany({
      where: { organizationId: ctx.organizationId },
      select: { id: true, name: true, config: true, active: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return {
    organisationDefault,
    organisationDefaultSummary: describeWeeklyOff(organisationDefault),
    patterns: patterns.map((p) => ({
      id: p.id,
      name: p.name,
      summary: describeWeeklyOff(p.config as unknown as WeeklyOffConfig),
      active: p.active,
    })),
  };
}
