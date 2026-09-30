import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { employeeName } from "@/domain/employees/name";
import { suggestEmployeeCode } from "@/services/employees/write";

/**
 * The name and designation this person's letters are signed with.
 *
 * `issueLetter` has always fallen back to the issuer — their name, then their
 * designation off their employee record — when a letter type has no signatory
 * configured. What did not exist was any way to *set* either of them. `/account`
 * had one child, `security`, which changes a password and nothing about who you
 * are; `User.name` is written when an account is created and updated by nothing
 * anywhere in the product. So the fallback fetched a name nobody could correct
 * and a designation nobody could choose, and the only way round it was to retype
 * both on every letter.
 *
 * **Owners and admins only.** A team member's name prints on their payslip and
 * their designation drives the reporting graph — the designation an employee
 * holds decides who approves their leave. Neither is theirs to change about
 * themselves; both stay with HR through the employee form, as they were. This
 * screen is the narrow case the product actually needs: the person who signs
 * the letters, setting what they sign as.
 *
 * The guard is deliberately two-sided. `org.settings.write` decides *whether*
 * you get the screen; `ctx.userId` decides *whose* record you edit. There is no
 * employee id parameter anywhere in this file, so an admin cannot reach somebody
 * else's record through it even by asking.
 */

export interface MyProfile {
  employeeId: string | null;
  name: string;
  designationId: string | null;
  designationTitle: string | null;
  /** The organisation's list, for the picker. */
  designations: { id: string; title: string }[];
}

export async function getMyProfile(ctx: AuthContext): Promise<MyProfile> {
  requireOrg(ctx);
  // A read. `requireWrite` here refused the whole page the moment a trial
  // ended or a payment lapsed -- under a banner that had promised read-only.
  requirePermission(ctx, "org.settings.write");

  const [employee, designations] = await Promise.all([
    ctx.employeeId
      ? prisma.employee.findFirst({
          where: { id: ctx.employeeId, organizationId: ctx.organizationId! },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            designationId: true,
            designation: { select: { title: true } },
          },
        })
      : null,
    prisma.designation.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    }),
  ]);

  return {
    employeeId: employee?.id ?? null,
    // The employee record is the authoritative name — `letterValues` says so at
    // length, and `updateEmployee` maintains it while nothing maintains
    // `User.name`. Falling back to the login's name only covers the owner of an
    // organisation provisioned before owners were given an employee record.
    name: employee ? employeeName(employee, ctx.name ?? "") : (ctx.name ?? ""),
    designationId: employee?.designationId ?? null,
    designationTitle: employee?.designation?.title ?? null,
    designations,
  };
}

/**
 * Put this person in the employee directory, so they have somewhere to hold a
 * designation.
 *
 * Only reachable by an owner or admin whose login has no employee record — an
 * organisation provisioned before owners were given one. Every organisation
 * created since has this already, and self-signup goes through the same path.
 *
 * **Not done silently on first visit**, which was the tempting version. An
 * active employee in a live employment state is a *seat* -- `context.ts` counts
 * exactly that for billing -- so creating one as a side effect of opening a
 * settings page would move somebody's bill because they looked at a screen.
 * It is a button, with the consequence written next to it.
 */
export async function joinEmployeeDirectory(ctx: AuthContext): Promise<MyProfile> {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  if (ctx.employeeId) return getMyProfile(ctx);

  const existing = await prisma.employee.findFirst({
    where: { userId: ctx.userId, organizationId: ctx.organizationId! },
    select: { id: true },
  });
  if (existing) return getMyProfile(ctx);

  const name = (ctx.name ?? "").trim() || "Owner";
  const [firstName, ...rest] = name.split(/\s+/);

  /**
   * The same generator the employee form uses, rather than a second one.
   *
   * This counted employees and added one, which is the identical defect that
   * broke seat purchases: delete one person and the next code collides with a
   * code already in use, permanently, because a count never catches up with a
   * series that has a gap in it. `employeeCode` is unique per organisation, so
   * it would have failed with the same unreadable 500.
   *
   * It also rebuilt the format by hand and hardcoded three digits, so an
   * organisation on a four-letter prefix got a code the rest of the product
   * would not recognise as one of its own.
   */
  const employeeCode = await suggestEmployeeCode(ctx);

  const created = await prisma.employee.create({
    data: {
      organizationId: ctx.organizationId!,
      userId: ctx.userId,
      employeeCode,
      firstName: firstName!,
      lastName: rest.join(" ") || null,
      joiningDate: new Date(),
      employmentState: "CONFIRMED",
      active: true,
    },
    select: { id: true },
  });

  await writeAudit(ctx, {
    action: "employee.created",
    entityType: "Employee",
    entityId: created.id,
    after: { ownProfile: true, reason: "owner had no employee record" },
  });

  // `ctx.employeeId` was resolved before this ran, so read it back from the row
  // just made rather than from the stale context.
  return getMyProfile({ ...ctx, employeeId: created.id });
}

export interface SaveProfileInput {
  name: string;
  designationId: string | null;
}

export async function saveMyProfile(ctx: AuthContext, input: SaveProfileInput): Promise<MyProfile> {
  requireOrg(ctx);
  requireWrite(ctx, "org.settings.write");

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give your name at least two characters.");

  // A designation belongs to this organisation or it does not exist. Without
  // this an id from another tenant would be accepted and quietly stored.
  if (input.designationId) {
    const designation = await prisma.designation.findFirst({
      where: {
        id: input.designationId,
        organizationId: ctx.organizationId!,
        active: true,
      },
      select: { id: true },
    });
    if (!designation) throw new NotFoundError("That designation");
  }

  const [firstName, ...rest] = name.split(/\s+/);
  const lastName = rest.join(" ") || null;

  await prisma.$transaction(async (tx) => {
    if (ctx.employeeId) {
      await tx.employee.update({
        where: { id: ctx.employeeId },
        data: { firstName: firstName!, lastName, designationId: input.designationId },
      });
    }
    // Kept in step, not left to drift. `ctx.name` is read all over the product
    // — the greeting, the audit trail, the notification bell — and it used to
    // keep whatever it was created with while the employee record moved on.
    await tx.user.update({ where: { id: ctx.userId }, data: { name } });
  });

  await writeAudit(ctx, {
    action: "employee.updated",
    entityType: "Employee",
    entityId: ctx.employeeId ?? ctx.userId,
    after: { ownProfile: true, name, designationId: input.designationId },
  });

  return getMyProfile(ctx);
}
