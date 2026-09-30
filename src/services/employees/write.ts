import { Prisma, type EmploymentState } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { assertSameTenant, requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ConflictError, SeatLimitError, ValidationError } from "@/lib/errors";
import { resolveWorkLocationId } from "@/domain/org/defaultWorkLocation";
import { writeAudit } from "@/lib/audit";
import { encryptOptional } from "@/lib/crypto/field";
import { isBillable, canActivateEmployee } from "@/domain/billing/seats";
import { todayInZone } from "@/domain/date";
import { aadhaarLastFour } from "@/domain/employees/aadhaar";
import { personalWeeklyOff, personalWeeklyOffErrors } from "@/domain/calendar/weeklyOff";
import {
  CODE_DIGITS,
  DEFAULT_CODE_PREFIX,
  normaliseCodePrefix,
} from "@/domain/employees/code";
import {
  EMPLOYEE_LOGIN_ROLES,
  type EmployeeLoginRole,
} from "@/domain/employees/loginRoles";
import { assignableRoles } from "@/lib/auth/permissions";
import { notify } from "@/lib/notify";
import { attachReportingLine, livePrimaryLine } from "@/services/org/structure";
import { setEmployeeLoginActive } from "./access";
import { provisionEmployeeLogin, type IssuedCredential } from "./credentials";

/**
 * Creating and changing employees.
 *
 * This is the half of the employee module that was missing. Reading was built;
 * writing was not, so an organisation could only ever contain the people the
 * seed script put there, and a real one was a dead end from the moment it was
 * created.
 *
 * Two rules run through everything here.
 *
 * **Seats are checked before anybody becomes active, not after.** Silently
 * exceeding a paid seat count is how a subscription leaks revenue and how a
 * customer gets a surprise bill. `canActivateEmployee` already encodes the
 * policy — including the platform's grace period and unmetered internal
 * organisations — so this only has to ask it.
 *
 * **Every state change is recorded.** `EmploymentStateChange` is what makes
 * "when did she go on notice?" answerable a year later, and it is written in
 * the same transaction as the change itself so the two cannot disagree.
 */

/** States that consume a seat, which is what the billing question turns on. */
async function seatCheck(ctx: AuthContext, becomingBillable: boolean) {
  if (!becomingBillable) return;

  const [organization, activeEmployees] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: ctx.organizationId! },
      select: { seatLimit: true, subscription: { select: { billingMode: true, seats: true } } },
    }),
    prisma.employee.count({
      where: {
        organizationId: ctx.organizationId!,
        active: true,
        employmentState: { in: ["TRAINING", "PROBATION", "REGULAR", "CONFIRMED", "NOTICE_PERIOD"] },
      },
    }),
  ]);

  const decision = canActivateEmployee({
    activeEmployees,
    seats: organization.subscription?.seats ?? organization.seatLimit,
    billingMode: organization.subscription?.billingMode ?? "PAID",
    now: new Date(),
  });

  if (!decision.allowed) {
    throw new SeatLimitError(decision.message ?? "There are no seats left.");
  }
}

export interface EmployeeInput {
  employeeCode: string;
  firstName: string;
  lastName?: string | null;
  joiningDate: string;
  workEmail?: string | null;
  personalEmail?: string | null;
  phone?: string | null;
  gender?: "MALE" | "FEMALE" | "OTHER" | "UNDISCLOSED" | null;
  dateOfBirth?: string | null;
  employmentType?: "FULL_TIME" | "PART_TIME" | "CONTRACT" | "INTERN" | "CONSULTANT";
  workMode?: "ONSITE" | "REMOTE" | "HYBRID";
  employmentState?: EmploymentState;
  /**
   * When training or probation ends.
   *
   * The column existed from the beginning and was written by nothing — not by
   * the create path, not by `changeEmploymentState` — so a probation had a
   * start and no end, and "who is due to be confirmed this month" was a
   * question the data could not answer.
   */
  confirmationDate?: string | null;
  departmentId?: string | null;
  designationId?: string | null;
  workLocationId?: string | null;
  shiftId?: string | null;
  weeklyOffPatternId?: string | null;
  /**
   * Their own rest days, consulted before the pattern. Null is "as the pattern
   * says", which is what everybody has until the Week off card says otherwise.
   */
  weeklyOffConfig?: { type: "FIXED" | "MULTIPLE"; days: number[] } | null;
  /** Their own paid week-off quota a month; null falls through to the designation. */
  weekOffsPerMonth?: number | null;
  /** Their primary manager. A reporting line, not a column on the employee. */
  reportsToEmployeeId?: string | null;
  /**
   * Overrides the organisation's `marking.self` attendance rule for this person.
   * Null follows the organisation. This is the exception that keeps field staff
   * working when an organisation moves to office-device-only.
   */
  allowSelfMarking?: boolean | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
  emergencyRelation?: string | null;
  bloodGroup?: string | null;
  /** Written encrypted, never read back in full. */
  pan?: string | null;
  aadhaar?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  uan?: string | null;
}

/** Every foreign key must belong to the same organisation as the employee. */
async function assertReferencesBelong(ctx: AuthContext, input: Partial<EmployeeInput>) {
  const checks: Promise<unknown>[] = [];
  const org = { organizationId: ctx.organizationId! };

  if (input.departmentId) {
    checks.push(
      prisma.department.findFirst({ where: { id: input.departmentId, ...org } }).then((d) => {
        if (!d) throw new ValidationError("That department does not exist.");
      }),
    );
  }
  if (input.designationId) {
    checks.push(
      prisma.designation.findFirst({ where: { id: input.designationId, ...org } }).then((d) => {
        if (!d) throw new ValidationError("That designation does not exist.");
      }),
    );
  }
  if (input.workLocationId) {
    checks.push(
      prisma.workLocation.findFirst({ where: { id: input.workLocationId, ...org } }).then((d) => {
        if (!d) throw new ValidationError("That work location does not exist.");
      }),
    );
  }
  if (input.shiftId) {
    checks.push(
      prisma.shift.findFirst({ where: { id: input.shiftId, ...org } }).then((d) => {
        if (!d) throw new ValidationError("That shift does not exist.");
      }),
    );
  }
  if (input.weeklyOffPatternId) {
    checks.push(
      prisma.weeklyOffPattern.findFirst({ where: { id: input.weeklyOffPatternId, ...org } }).then((d) => {
        if (!d) throw new ValidationError("That week-off pattern does not exist.");
      }),
    );
  }

  await Promise.all(checks);
}

const date = (value: string | null | undefined) =>
  value ? new Date(`${value.slice(0, 10)}T00:00:00.000Z`) : null;

/**
 * The person's own rest days, as the column stores them.
 *
 * Refused here rather than in the schema, because the three refusals — no
 * days, a weekday outside 0–6, all seven — each deserve a sentence the card
 * can show, and because the resolver reads the column back through the same
 * rule: what this will not write, `readPersonalWeeklyOff` will not trust.
 */
function personalWeeklyOffPatch(input: Partial<EmployeeInput>): Pick<Prisma.EmployeeUpdateInput, "weeklyOffConfig"> {
  if (input.weeklyOffConfig === undefined) return {};
  if (input.weeklyOffConfig === null) return { weeklyOffConfig: Prisma.DbNull };
  const errors = personalWeeklyOffErrors(input.weeklyOffConfig.days);
  if (errors.length > 0) throw new ValidationError(errors.join(" "));
  return { weeklyOffConfig: personalWeeklyOff(input.weeklyOffConfig.days) };
}

/** The encrypted columns, written only when a value was actually supplied. */
function identifierPatch(input: Partial<EmployeeInput>) {
  const patch: Record<string, string | null> = {};
  if (input.pan !== undefined) patch.panCipher = encryptOptional(input.pan);
  // Only the last four digits are kept. Holding the whole number carries
  // obligations under the Aadhaar Act that holding four does not, and four is
  // enough to confirm which number somebody means.
  if (input.aadhaar !== undefined) {
    patch.aadhaarCipher = encryptOptional(aadhaarLastFour(input.aadhaar));
  }
  if (input.bankName !== undefined) patch.bankNameCipher = encryptOptional(input.bankName);
  if (input.bankAccount !== undefined) patch.bankAccountCipher = encryptOptional(input.bankAccount);
  if (input.bankIfsc !== undefined) patch.bankIfscCipher = encryptOptional(input.bankIfsc);
  if (input.uan !== undefined) patch.uanCipher = encryptOptional(input.uan);
  // Health data. It sat in plaintext beside all of these for as long as the
  // column existed; the plaintext one is cleared as it is encrypted, so a row
  // is never carrying both.
  if (input.bloodGroup !== undefined) {
    patch.bloodGroupCipher = encryptOptional(input.bloodGroup);
    patch.bloodGroup = null;
  }
  return patch;
}

/**
 * The row itself, written inside whatever transaction the caller is running.
 *
 * Extracted so a single create and a bulk import produce byte-for-byte the same
 * employee. A spreadsheet import that quietly diverged from the form — a field
 * trimmed differently, a default not applied, the opening history entry missing —
 * would be discovered months later by somebody reading a payroll report.
 */
async function insertEmployee(
  tx: Prisma.TransactionClient,
  ctx: AuthContext,
  input: EmployeeInput,
  state: EmploymentState,
) {
  const created = await tx.employee.create({
    data: {
      organizationId: ctx.organizationId!,
      employeeCode: input.employeeCode.trim(),
      firstName: input.firstName.trim(),
      lastName: input.lastName?.trim() || null,
      workEmail: input.workEmail?.trim().toLowerCase() || null,
      personalEmail: input.personalEmail?.trim().toLowerCase() || null,
      phone: input.phone?.trim() || null,
      gender: input.gender ?? null,
      dateOfBirth: date(input.dateOfBirth),
      joiningDate: date(input.joiningDate)!,
      employmentType: input.employmentType ?? "FULL_TIME",
      workMode: input.workMode ?? "ONSITE",
      employmentState: state,
      confirmationDate: date(input.confirmationDate),
      departmentId: input.departmentId || null,
      designationId: input.designationId || null,
      workLocationId: input.workLocationId || null,
      shiftId: input.shiftId || null,
      weeklyOffPatternId: input.weeklyOffPatternId || null,
      // The create schema admits both, so they are honoured rather than
      // dropped -- a field the API accepts and the row never carries is the
      // shape of bug `confirmationDate` was.
      ...personalWeeklyOffPatch(input),
      weekOffsPerMonth: input.weekOffsPerMonth ?? null,
      allowSelfMarking: input.allowSelfMarking ?? null,
      addressLine1: input.addressLine1?.trim() || null,
      city: input.city?.trim() || null,
      state: input.state?.trim() || null,
      postalCode: input.postalCode?.trim() || null,
      emergencyName: input.emergencyName?.trim() || null,
      emergencyPhone: input.emergencyPhone?.trim() || null,
      emergencyRelation: input.emergencyRelation?.trim() || null,
      ...identifierPatch(input),
    },
  });

  // The first entry in the history, so the record starts with a beginning
  // rather than appearing to have always been in this state.
  await tx.employmentStateChange.create({
    data: {
      employeeId: created.id,
      fromState: null,
      toState: state,
      effectiveOn: created.joiningDate,
      reason: "Added to the directory",
      actorId: ctx.userId,
    },
  });

  return created;
}

/** Used by the bulk importer, which owns its own transaction. */
export { insertEmployee };

/**
 * Whether this new employee also gets a way in.
 *
 * Optional rather than automatic: a directory row for somebody who has not
 * started yet, or a contractor who will never open the app, should not consume
 * an email address or leave a live credential lying around.
 */
export interface LoginOption {
  create: boolean;
  role?: EmployeeLoginRole;
}

export async function createEmployee(
  ctx: AuthContext,
  input: EmployeeInput,
  login: LoginOption = { create: false },
): Promise<{ employee: Awaited<ReturnType<typeof insertEmployee>>; credential: IssuedCredential | null }> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.create");

  const code = input.employeeCode.trim();
  if (!code) throw new ValidationError("An employee code is required.");

  const clash = await prisma.employee.findFirst({
    where: { organizationId: ctx.organizationId!, employeeCode: code },
    select: { id: true },
  });
  if (clash) throw new ConflictError(`Employee code ${code} is already in use.`);

  // A branch, whether or not the form offered to pick one.
  //
  // Measured on production before this was written: every employee in every
  // organisation had `workLocationId = NULL`. That is what the product does by
  // default -- the field may be skipped and nothing fills it in -- and the
  // consequence was the entire geofence. `markAttendance` measures a distance
  // only when the employee has an active work location; with none, requireGps
  // forces coordinates to be *present* and never compares them, so two hundred
  // metres and two hundred kilometres were the same answer for everybody.
  //
  // Only on create. On update an absent field means "leave it" and an explicit
  // null means "take them off it", and defaulting there would make removing
  // somebody from a branch impossible.
  const withLocation: EmployeeInput = {
    ...input,
    workLocationId: resolveWorkLocationId(
      await prisma.workLocation.findMany({
        where: { organizationId: ctx.organizationId! },
        select: { id: true, active: true, isPrimary: true, createdAt: true },
      }),
      input.workLocationId,
    ),
  };

  await assertReferencesBelong(ctx, withLocation);

  const state = withLocation.employmentState ?? "PROBATION";
  await seatCheck(ctx, isBillable(state, true));

  // The row and its login are one transaction: an employee that exists with a
  // half-made account, or an orphaned User with no employee behind it, are both
  // worse than a failed create.
  const { employee, credential } = await prisma.$transaction(async (tx) => {
    const created = await insertEmployee(tx, ctx, withLocation, state);
    const issued = login.create
      ? await provisionEmployeeLogin(tx, ctx, created, {
          role: login.role,
          organizationSlug: ctx.organization?.slug ?? null,
        })
      : null;
    return { employee: created, credential: issued };
  });

  // Outside the transaction on purpose: `attachReportingLine` runs its own, and
  // an employee who exists without a manager is a state the product already
  // handles -- their approvals fall to HR. An employee who does not exist
  // because their manager could not be attached is not.
  if (withLocation.reportsToEmployeeId) {
    await attachReportingLine(ctx, {
      employeeId: employee.id,
      managerId: withLocation.reportsToEmployeeId,
      startDate: withLocation.joiningDate,
    });
  } else {
    // Nobody was told about this before, in any organisation created through
    // the product -- and every one of them has this be true for everybody.
    await notify.toOrgRoles(ctx.organizationId!, ["HR_MANAGER", "ADMIN", "ORG_OWNER"], {
      type: "employee.no_manager",
      title: "Somebody was added with no manager",
      body: `${[withLocation.firstName, withLocation.lastName].filter(Boolean).join(" ")} has no reporting line, so their leave and attendance corrections will come to you.`,
      link: `/employees`,
    });
  }

  await writeAudit(ctx, {
    action: "employee.created",
    entityType: "Employee",
    entityId: employee.id,
    after: {
      employeeCode: code,
      name: employee.firstName,
      employmentState: state,
      login: credential ? { email: credential.email, role: login.role ?? "TEAM_MEMBER" } : null,
    },
  });

  return { employee, credential };
}

export async function updateEmployee(
  ctx: AuthContext,
  employeeId: string,
  input: Partial<EmployeeInput>,
) {
  requireOrg(ctx);
  requireWrite(ctx, "employee.update");

  const existing = await prisma.employee.findUnique({ where: { id: employeeId } });
  assertSameTenant(ctx, existing, "That employee");

  if (input.employeeCode && input.employeeCode.trim() !== existing!.employeeCode) {
    const clash = await prisma.employee.findFirst({
      where: {
        organizationId: ctx.organizationId!,
        employeeCode: input.employeeCode.trim(),
        NOT: { id: employeeId },
      },
      select: { id: true },
    });
    if (clash) throw new ConflictError(`Employee code ${input.employeeCode.trim()} is already in use.`);
  }

  await assertReferencesBelong(ctx, input);

  // Employment state is deliberately not changeable here — it moves through
  // `changeEmploymentState`, which records why and when.
  const data: Prisma.EmployeeUpdateInput = {
    ...(input.employeeCode !== undefined ? { employeeCode: input.employeeCode.trim() } : {}),
    ...(input.firstName !== undefined ? { firstName: input.firstName.trim() } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName?.trim() || null } : {}),
    ...(input.workEmail !== undefined
      ? { workEmail: input.workEmail?.trim().toLowerCase() || null }
      : {}),
    ...(input.personalEmail !== undefined
      ? { personalEmail: input.personalEmail?.trim().toLowerCase() || null }
      : {}),
    ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
    ...(input.gender !== undefined ? { gender: input.gender ?? null } : {}),
    ...(input.dateOfBirth !== undefined ? { dateOfBirth: date(input.dateOfBirth) } : {}),
    ...(input.joiningDate !== undefined ? { joiningDate: date(input.joiningDate)! } : {}),
    ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
    ...(input.workMode !== undefined ? { workMode: input.workMode } : {}),
    ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1?.trim() || null } : {}),
    ...(input.city !== undefined ? { city: input.city?.trim() || null } : {}),
    ...(input.state !== undefined ? { state: input.state?.trim() || null } : {}),
    ...(input.postalCode !== undefined ? { postalCode: input.postalCode?.trim() || null } : {}),
    ...(input.emergencyName !== undefined ? { emergencyName: input.emergencyName?.trim() || null } : {}),
    ...(input.emergencyPhone !== undefined ? { emergencyPhone: input.emergencyPhone?.trim() || null } : {}),
    ...(input.emergencyRelation !== undefined
      ? { emergencyRelation: input.emergencyRelation?.trim() || null }
      : {}),
    ...(input.allowSelfMarking !== undefined
      ? { allowSelfMarking: input.allowSelfMarking ?? null }
      : {}),
    ...(input.departmentId !== undefined
      ? { department: input.departmentId ? { connect: { id: input.departmentId } } : { disconnect: true } }
      : {}),
    ...(input.designationId !== undefined
      ? { designation: input.designationId ? { connect: { id: input.designationId } } : { disconnect: true } }
      : {}),
    ...(input.workLocationId !== undefined
      ? { workLocation: input.workLocationId ? { connect: { id: input.workLocationId } } : { disconnect: true } }
      : {}),
    ...(input.shiftId !== undefined
      ? { shift: input.shiftId ? { connect: { id: input.shiftId } } : { disconnect: true } }
      : {}),
    ...(input.weeklyOffPatternId !== undefined
      ? {
          weeklyOffPattern: input.weeklyOffPatternId
            ? { connect: { id: input.weeklyOffPatternId } }
            : { disconnect: true },
        }
      : {}),
    // The Week off card on the profile. Their own days go in front of the
    // pattern above; their own quota goes in front of the designation's.
    ...personalWeeklyOffPatch(input),
    ...(input.weekOffsPerMonth !== undefined
      ? { weekOffsPerMonth: input.weekOffsPerMonth ?? null }
      : {}),
    // Written by `insertEmployee` and dropped by every edit since: the dialog
    // renders the field, the PATCH sends it, and this object never carried it.
    // So a probation end date could be set once, at creation, and never
    // corrected.
    ...(input.confirmationDate !== undefined
      ? { confirmationDate: date(input.confirmationDate) }
      : {}),
    ...identifierPatch(input),
  };

  /**
   * Changing somebody's manager is an ordinary edit, authorised by
   * `employee.update` rather than `org.structure.manage` -- the same reason
   * `attachReportingLine` exists.
   *
   * Decided *before* the fields are written. It ran after, so a manager change
   * the structure rules refused ("a new line has to start after the one it
   * replaces") still saved every other field and then reported a failure --
   * the person read "nothing was saved" over a record that had changed.
   *
   * And `null` is a choice, not an omission: the dialog offers "Nobody -- HR
   * and Admin approve for them", and picking it used to be ignored. The live
   * primary line ends today.
   */
  if (input.reportsToEmployeeId !== undefined) {
    // `""` is nobody as well -- the schema admits it, `createEmployee` reads
    // it that way, and the form's own select is an empty string before it is
    // `null`. Branched on as an id it reached `attachReportingLine`, found no
    // such employee, and refused the whole edit with a 404 naming the wrong
    // thing.
    const reportsTo = input.reportsToEmployeeId || null;
    const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
    const current = await livePrimaryLine(ctx, employeeId);
    if (reportsTo === null) {
      if (current) {
        // A line scheduled to start later ends on its own start day -- a
        // zero-length span, which is what endReportingLine allows -- never
        // before it, which would be a line that ended before it existed.
        const ends = new Date(`${today}T00:00:00.000Z`);
        const endDate =
          current.startDate && current.startDate > ends ? current.startDate : ends;
        await prisma.reportingRelationship.update({
          where: { id: current.id },
          data: { endDate },
        });
        await writeAudit(ctx, {
          action: "reporting.changed",
          entityType: "ReportingRelationship",
          entityId: current.id,
          before: { managerId: current.managerId, endDate: null },
          after: { endDate: today, reason: "manager removed from the employee form" },
        });
      }
    } else if (current?.managerId !== reportsTo) {
      await attachReportingLine(ctx, {
        employeeId,
        managerId: reportsTo,
        startDate: today,
      });
    }
  }

  const updated = await prisma.employee.update({ where: { id: employeeId }, data });

  await writeAudit(ctx, {
    action: "employee.updated",
    entityType: "Employee",
    entityId: employeeId,
    // Identifiers are encrypted and never audited in the clear; the audit
    // redactor strips anything cipher-shaped, and the names are enough to
    // answer "who changed this record".
    before: { employeeCode: existing!.employeeCode, firstName: existing!.firstName },
    after: { employeeCode: updated.employeeCode, firstName: updated.firstName },
  });

  return updated;
}

/**
 * Moves someone between employment states, and records why.
 *
 * Leaving states (`RESIGNED`, `TERMINATED`, `INACTIVE`) also clear `active`,
 * which is what frees the seat. Coming back the other way needs a seat again,
 * so it is checked.
 */
const LEAVING: EmploymentState[] = ["RESIGNED", "TERMINATED", "INACTIVE"];

export async function changeEmploymentState(
  ctx: AuthContext,
  employeeId: string,
  input: { toState: EmploymentState; effectiveOn?: string; reason?: string },
) {
  requireOrg(ctx);
  requireWrite(
    ctx,
    LEAVING.includes(input.toState) ? "employee.terminate" : "employee.state.change",
  );

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  assertSameTenant(ctx, employee, "That employee");

  if (employee!.employmentState === input.toState) {
    throw new ConflictError(`They are already ${input.toState.toLowerCase().replace("_", " ")}.`);
  }

  const leaving = LEAVING.includes(input.toState);
  const wasBillable = isBillable(employee!.employmentState, employee!.active);
  const willBeBillable = isBillable(input.toState, !leaving);

  // Only a move that starts consuming a seat needs one.
  if (willBeBillable && !wasBillable) {
    await seatCheck(ctx, true);
  }

  const effectiveOn =
    date(input.effectiveOn) ??
    new Date(`${todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata")}T00:00:00.000Z`);

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.employee.update({
      where: { id: employeeId },
      data: {
        employmentState: input.toState,
        active: !leaving,
        ...(leaving ? { exitDate: effectiveOn } : { exitDate: null }),
        // `confirmationDate` was written once at creation and touched by
        // nothing afterwards, so a confirmed employee kept the date their
        // probation was *supposed* to end for ever. Becoming permanent sets it
        // to the day it actually happened; moving back into training or
        // probation clears it, because there is no confirmation any more.
        ...(input.toState === "REGULAR" || input.toState === "CONFIRMED"
          ? { confirmationDate: effectiveOn }
          : input.toState === "TRAINING" || input.toState === "PROBATION"
            ? { confirmationDate: null }
            : {}),
      },
    });

    await tx.employmentStateChange.create({
      data: {
        employeeId,
        fromState: employee!.employmentState,
        toState: input.toState,
        effectiveOn,
        reason: input.reason?.trim() || null,
        actorId: ctx.userId,
      },
    });

    // Somebody who has left keeps their record and loses their key.
    await setEmployeeLoginActive(tx, employee!, { active: !leaving, actorId: ctx.userId });

    return next;
  });

  await writeAudit(ctx, {
    action: "employee.state_changed",
    entityType: "Employee",
    entityId: employeeId,
    before: { employmentState: employee!.employmentState, active: employee!.active },
    after: {
      employmentState: input.toState,
      active: !leaving,
      reason: input.reason?.trim() || null,
    },
  });

  return updated;
}

/** The lists a create or edit form needs to offer real choices. */
export async function getEmployeeFormOptions(ctx: AuthContext) {
  requireOrg(ctx);
  // A read: the lists a form offers. The save that follows is guarded on its
  // own, so a lapsed organisation sees the form disabled rather than a
  // dialog saying its lists "could not be loaded".
  requirePermission(ctx, "employee.read.all");

  // `active: true` throughout. Structure rows are deactivated rather than
  // deleted -- a department with a year of payroll behind it cannot be removed
  // -- and the form was still offering every switched-off department,
  // designation, location, shift and pattern as a live choice.
  const org = { organizationId: ctx.organizationId!, active: true };
  const [departments, designations, locations, shifts, patterns, organization] = await Promise.all([
    prisma.department.findMany({ where: org, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.designation.findMany({
      where: org,
      select: { id: true, title: true },
      orderBy: [{ level: "asc" }, { title: "asc" }],
    }),
    prisma.workLocation.findMany({ where: org, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.shift.findMany({ where: org, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.weeklyOffPattern.findMany({ where: org, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.organization.findUnique({
      where: { id: ctx.organizationId! },
      select: { probationDays: true, trainingDays: true },
    }),
  ]);

  // Who could be somebody's manager, and which designations report to which.
  // The form uses the two together to *suggest* a manager once a designation is
  // chosen -- never to decide one silently. A stranger quietly receiving
  // somebody's leave requests and approving their pay-affecting attendance
  // corrections is the kind of mistake that surfaces months later.
  const [managers, edges] = await Promise.all([
    prisma.employee.findMany({
      where: {
        organizationId: ctx.organizationId!,
        active: true,
        employmentState: { notIn: ["RESIGNED", "TERMINATED", "INACTIVE"] },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        designationId: true,
        designation: { select: { title: true } },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
    prisma.designationReporting.findMany({
      where: { organizationId: ctx.organizationId! },
      select: { designationId: true, reportsToDesignationId: true },
    }),
  ]);

  const designationParents: Record<string, string[]> = {};
  for (const edge of edges) {
    designationParents[edge.designationId] = [
      ...(designationParents[edge.designationId] ?? []),
      edge.reportsToDesignationId,
    ];
  }

  const nextCode = await suggestEmployeeCode(ctx);
  return {
    managers: managers.map((m) => ({
      id: m.id,
      name: [m.firstName, m.lastName].filter(Boolean).join(" "),
      designationId: m.designationId,
      designation: m.designation?.title ?? null,
    })),
    designationParents,
    departments,
    designations,
    locations,
    shifts,
    patterns,
    nextCode,
    probationDays: organization?.probationDays ?? 90,
    trainingDays: organization?.trainingDays ?? 30,
    // Worked out here rather than hard-coded in the form. `assignableRoles` has
    // been exported and called by nothing, so the picker offered an HR Manager
    // the ADMIN option and the server refused it on submit -- the client was
    // already lying about what it would accept. Kiosk is filtered out: it is
    // rank 99, so `canManageRole` allows it, and it is not a person.
    assignableRoles: assignableRoles(ctx.role).filter((role) =>
      EMPLOYEE_LOGIN_ROLES.includes(role as EmployeeLoginRole),
    ) as EmployeeLoginRole[],
    // Pay is a narrower permission than adding a person, on purpose. The form
    // hides the CTC field rather than offering one the server would refuse.
    canSetSalary: ctx.permissions.has("employee.salary.manage"),
  };
}

/**
 * The next code in the organisation's own series.
 *
 * The prefix is the organisation's, chosen when it was created. This used to
 * *infer* it from whichever existing code had the highest numeric tail, which
 * picked the wrong one the moment a directory held two patterns -- and handed
 * every brand-new organisation "EMP001", so every customer's people were
 * numbered as if they worked for the same company.
 *
 * The maximum is taken in SQL. The old version loaded every employee code in
 * the organisation into memory to find it, on every form open.
 */
export async function suggestEmployeeCode(ctx: AuthContext): Promise<string> {
  const org = await prisma.organization.findUnique({
    where: { id: ctx.organizationId! },
    select: { employeeCodePrefix: true },
  });
  const prefix = normaliseCodePrefix(org?.employeeCodePrefix ?? DEFAULT_CODE_PREFIX);

  // Codes are text, so "ACM1000" sorts below "ACM999" and an ORDER BY would
  // hand back the wrong one. The numeric tail is compared as a number.
  const [row] = await prisma.$queryRaw<{ highest: number | null }[]>`
    SELECT MAX(CAST(SUBSTRING("employeeCode" FROM '[0-9]+$') AS INTEGER)) AS highest
    FROM "Employee"
    WHERE "organizationId" = ${ctx.organizationId!}
      AND "employeeCode" ~ ${`^${prefix}[0-9]+$`}
  `;

  const next = (row?.highest ?? 0) + 1;
  return `${prefix}${String(next).padStart(CODE_DIGITS, "0")}`;
}
