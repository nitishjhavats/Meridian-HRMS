import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { assertSameTenant, requireOrg, requireWrite } from "@/lib/auth/guard";
import { canManageRole, type SystemRole } from "@/lib/auth/permissions";
import { generateTemporaryPassword, hashPassword } from "@/lib/auth/password";
import { revokeAllSessions } from "@/lib/auth/session";
import { writeAudit } from "@/lib/audit";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";

/**
 * Giving an employee a way in.
 *
 * Until this existed, `insertEmployee` wrote a directory row and nothing else:
 * `Employee.userId` stayed null, no `User` was created, and the only accounts on
 * the whole instance were the organisation's owner and its kiosk devices. Every
 * employee-facing screen in the product — check in, apply for leave, download a
 * payslip — was unreachable by the people it was built for, and `checkIn.ts`
 * said so in as many words: *"Your login is not linked to an employee record."*
 *
 * There is no email in this product, deliberately. So a credential is **shown
 * once** to whoever created it and handed over out of band. That places two
 * obligations on this module:
 *
 *   - the password is single-use in spirit — `mustChangePassword` is set, and
 *     the layouts refuse every screen until it has been changed;
 *   - it is never recoverable. Nothing stores the plaintext, and losing it means
 *     issuing a new one, which is an audited act.
 */

import { EMPLOYEE_LOGIN_ROLES, type EmployeeLoginRole } from "@/domain/employees/loginRoles";

// Re-exported so the many callers that already import it from here keep working.
export { EMPLOYEE_LOGIN_ROLES, type EmployeeLoginRole };

export interface IssuedCredential {
  employeeCode: string;
  name: string;
  email: string;
  temporaryPassword: string;
  signInUrl: string;
}

/**
 * Where to send somebody to sign in.
 *
 * The organisation's own entry URL rather than the bare host: it carries their
 * name and logo, so the link an administrator forwards looks like it came from
 * their own company rather than from a product they have never heard of.
 */
export function signInUrl(slug: string | null): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return slug ? `${base}/o/${slug}` : `${base}/login`;
}

function assertRoleAllowed(ctx: AuthContext, role: EmployeeLoginRole) {
  if (!EMPLOYEE_LOGIN_ROLES.includes(role)) {
    throw new ValidationError("That is not a role an employee login may have.");
  }
  // Nobody hands out a role at or above their own. Without this, an HR Manager
  // who may create employees could mint themselves an Admin.
  if (!canManageRole(ctx.role, role as SystemRole)) {
    throw new ForbiddenError(`You cannot give somebody the ${role.toLowerCase()} role.`);
  }
}

function loginEmail(input: { workEmail?: string | null; personalEmail?: string | null }): string {
  const email = (input.workEmail ?? input.personalEmail ?? "").trim().toLowerCase();
  if (!email) {
    throw new ValidationError(
      "A login needs an email address. Add a work email (or a personal one) first.",
    );
  }
  return email;
}

/**
 * Creates the `User` behind an employee, inside the caller's transaction.
 *
 * Used by both the single create and the bulk import so the two cannot diverge
 * on what a new login looks like.
 */
export async function provisionEmployeeLogin(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string | null;
    workEmail: string | null;
    personalEmail: string | null;
  },
  options: { role?: EmployeeLoginRole; organizationSlug: string | null } = {
    organizationSlug: null,
  },
): Promise<IssuedCredential> {
  const role = options.role ?? "TEAM_MEMBER";
  assertRoleAllowed(ctx, role);

  const email = loginEmail(employee);
  const name = [employee.firstName, employee.lastName].filter(Boolean).join(" ");

  const clash = await tx.user.findFirst({
    where: { organizationId: ctx.organizationId!, email },
    select: { id: true },
  });
  if (clash) {
    throw new ConflictError(`${email} already has a login in this organisation.`);
  }

  const temporaryPassword = generateTemporaryPassword();

  const user = await tx.user.create({
    data: {
      organizationId: ctx.organizationId!,
      email,
      name,
      role,
      status: "ACTIVE",
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
    },
    select: { id: true },
  });

  await tx.employee.update({ where: { id: employee.id }, data: { userId: user.id } });

  return {
    employeeCode: employee.employeeCode,
    name,
    email,
    temporaryPassword,
    signInUrl: signInUrl(options.organizationSlug),
  };
}

/**
 * A login for an employee who is already in the directory.
 *
 * Everybody imported before logins existed is in exactly this position, and so
 * is anybody deliberately added without one who later needs access. It is the
 * same provisioning the create path runs, reached from the profile.
 */
export async function createLoginForEmployee(
  ctx: AuthContext,
  employeeId: string,
  role?: EmployeeLoginRole,
): Promise<IssuedCredential> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.update");

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      organizationId: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      workEmail: true,
      personalEmail: true,
      userId: true,
      organization: { select: { slug: true } },
    },
  });
  assertSameTenant(ctx, employee, "That employee");

  if (employee!.userId) {
    throw new ConflictError(
      "That employee already has a login. Reset their password instead of making a second one.",
    );
  }

  const credential = await prisma.$transaction((tx) =>
    provisionEmployeeLogin(tx, ctx, employee!, {
      role,
      organizationSlug: employee!.organization?.slug ?? null,
    }),
  );

  await writeAudit(ctx, {
    action: "employee.updated",
    entityType: "Employee",
    entityId: employee!.id,
    after: { login: { email: credential.email, role: role ?? "TEAM_MEMBER" } },
  });

  return credential;
}

/**
 * A new one-time password for somebody who has lost theirs.
 *
 * The superadmin-released OTP at `/forgot-password` only ever answered for
 * `ORG_OWNER` and `ADMIN` — every other role asked for a reset and silently got
 * nothing back. That is the right design for an organisation's *own* administrators,
 * whose reset must not depend on themselves; it is the wrong one for the two
 * hundred people who work there. Their administrator resets them, here.
 */
export async function resetEmployeePassword(
  ctx: AuthContext,
  employeeId: string,
): Promise<IssuedCredential> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.update");

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      organizationId: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      user: { select: { id: true, email: true, role: true, status: true } },
      organization: { select: { slug: true } },
    },
  });
  assertSameTenant(ctx, employee, "That employee");

  const user = employee!.user;
  if (!user) {
    throw new ValidationError(
      "That employee has no login yet. Create one instead of resetting a password.",
    );
  }
  // The same rank rule as issuing: an HR Manager does not reset an Admin's
  // password and then sign in as them.
  if (!canManageRole(ctx.role, user.role as SystemRole)) {
    throw new ForbiddenError("You cannot reset that person's password.");
  }

  const temporaryPassword = generateTemporaryPassword();

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  // Whoever had the old password — including whoever they lost it to — stops
  // here.
  await revokeAllSessions(user.id, { revokedById: ctx.userId });

  await writeAudit(ctx, {
    action: "auth.password_changed",
    entityType: "User",
    entityId: user.id,
    metadata: { reset: "by administrator", employeeId: employee!.id },
  });

  return {
    employeeCode: employee!.employeeCode,
    name: [employee!.firstName, employee!.lastName].filter(Boolean).join(" "),
    email: user.email,
    temporaryPassword,
    signInUrl: signInUrl(employee!.organization?.slug ?? null),
  };
}
