import type { EmploymentState, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertSameTenant,
  hasPermission,
  requireOrg,
  requirePermission,
  scopedEmployeeWhere,
  visibleEmployeeIds,
} from "@/lib/auth/guard";
import { NotFoundError } from "@/lib/errors";
import { decryptOptional, maskTail } from "@/lib/crypto/field";
import { BILLABLE_STATES } from "@/domain/billing/seats";

/**
 * Reading employees.
 *
 * Scope is derived from the caller's permissions, never from a query parameter:
 * an Admin sees the organisation, a Team Lead sees their reporting line, and a
 * Team Member sees only themselves.
 *
 * **An office device is not here, and that is the answer rather than a gap.**
 * A kiosk is a `User` with role `KIOSK` and, by construction, no `Employee`
 * row: it has no joining date, no designation, no reporting line, no salary and
 * no attendance of its own, which is exactly why it costs no seat and cannot
 * read a payslip. Every row this list produces is an employee that a dozen
 * screens then treat as a person -- profile, salary, leave, documents,
 * headcount -- so a device sitting among them would be a row where most of what
 * the screen offers means nothing, and giving it an `Employee` record to make
 * the row work would put a tablet into the seat count and the payroll register.
 *
 * A device is managed where it is a device: Settings -> Attendance rules ->
 * office devices, which lists each one with its work location, when it was last
 * seen, and the two things anybody actually wants to do to it -- revoke it, or
 * give it a new password. From the platform console it appears in the People
 * card under "Accounts with no employee record" and can be signed in as,
 * read-only, because "why does the reception screen show nobody" is a real
 * support question.
 */

export interface EmployeeRow {
  id: string;
  employeeCode: string;
  name: string;
  photoUrl: string | null;
  designation: string | null;
  department: string | null;
  employmentState: EmploymentState;
  employmentType: string;
  active: boolean;
  joiningDate: Date;
  workEmail: string | null;
  phone: string | null;
  managers: string[];
  faceEnrolled: boolean;
  billable: boolean;
  /**
   * The branch their attendance is measured against, or null.
   *
   * Null is the interesting value: `markAttendance` only compares a distance
   * for somebody who has an active work location, so an employee with none has
   * their coordinates collected and never checked. Every employee on production
   * was null when this was added, which is why the list now says so.
   */
  workLocation: string | null;
}

export interface EmployeeFilters {
  search?: string;
  departmentId?: string;
  employmentState?: EmploymentState[];
  activeOnly?: boolean;
}

export async function listEmployees(
  ctx: AuthContext,
  filters: EmployeeFilters = {},
): Promise<EmployeeRow[]> {
  requireOrg(ctx);
  const scoped = await scopedEmployeeWhere(ctx, "employee.read");

  // `scopedEmployeeWhere` keys on employeeId; here the id *is* the employee.
  const where: Prisma.EmployeeWhereInput = {
    organizationId: ctx.organizationId,
    ...(scoped.employeeId ? { id: scoped.employeeId } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
    ...(filters.employmentState?.length ? { employmentState: { in: filters.employmentState } } : {}),
    ...(filters.activeOnly ? { active: true } : {}),
    ...(filters.search
      ? {
          OR: [
            { firstName: { contains: filters.search, mode: "insensitive" } },
            { lastName: { contains: filters.search, mode: "insensitive" } },
            { employeeCode: { contains: filters.search, mode: "insensitive" } },
            { workEmail: { contains: filters.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const employees = await prisma.employee.findMany({
    where,
    orderBy: [{ active: "desc" }, { employeeCode: "asc" }],
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      photoKey: true,
      facePhotoKey: true,
      faceEnrolledAt: true,
      employmentState: true,
      employmentType: true,
      active: true,
      joiningDate: true,
      workEmail: true,
      phone: true,
      designation: { select: { title: true } },
      department: { select: { name: true } },
      workLocation: { select: { name: true, active: true } },
      managers: { select: { manager: { select: { firstName: true, lastName: true } } } },
    },
  });

  return employees.map((e) => ({
    id: e.id,
    employeeCode: e.employeeCode,
    name: [e.firstName, e.lastName].filter(Boolean).join(" "),
    photoUrl: e.photoKey ? `/api/files/${e.photoKey}` : e.facePhotoKey ? `/api/files/${e.facePhotoKey}` : null,
    designation: e.designation?.title ?? null,
    department: e.department?.name ?? null,
    employmentState: e.employmentState,
    employmentType: e.employmentType,
    active: e.active,
    joiningDate: e.joiningDate,
    workEmail: e.workEmail,
    phone: e.phone,
    managers: e.managers.map((m) =>
      [m.manager.firstName, m.manager.lastName].filter(Boolean).join(" "),
    ),
    faceEnrolled: e.faceEnrolledAt != null,
    billable: e.active && BILLABLE_STATES.includes(e.employmentState as never),
    // A switched-off branch reads as none, because that is what it is worth:
    // the server refuses to measure against an inactive location.
    workLocation: e.workLocation?.active ? e.workLocation.name : null,
  }));
}

/**
 * One employee's full profile.
 *
 * Encrypted identifiers are decrypted only for callers who may see salary-grade
 * detail, and even then are masked unless explicitly revealed — a screen-share
 * during a standup should not leak somebody's Aadhaar number.
 */
export async function getEmployee(ctx: AuthContext, employeeId: string) {
  requireOrg(ctx);

  const visible = await visibleEmployeeIds(ctx, "employee.read");
  if (visible !== null && !visible.includes(employeeId)) {
    throw new NotFoundError("That employee");
  }

  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    include: {
      department: { select: { id: true, name: true } },
      // `weekOffsPerMonth` so the profile can say what a blank personal quota
      // falls through to, in the designation's own figure.
      designation: { select: { id: true, title: true, weekOffsPerMonth: true } },
      workLocation: { select: { id: true, name: true, radiusMeters: true } },
      shift: { select: { id: true, name: true, startTime: true, endTime: true } },
      weeklyOffPattern: { select: { id: true, name: true, type: true, config: true } },
      user: { select: { id: true, email: true, role: true, status: true, lastLoginAt: true } },
      managers: {
        select: {
          type: true,
          manager: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        },
      },
      reports: {
        select: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        },
      },
      trainingPlans: { orderBy: { startDate: "desc" } },
      stateHistory: { orderBy: { effectiveOn: "desc" }, take: 10 },
      salaryProfiles: { orderBy: { effectiveFrom: "desc" }, take: 1 },
    },
  });

  assertSameTenant(ctx, employee, "That employee");

  const seesSensitive =
    hasPermission(ctx, "employee.salary.read") || ctx.employeeId === employeeId;

  return {
    ...employee!,
    name: [employee!.firstName, employee!.lastName].filter(Boolean).join(" "),
    photoUrl: employee!.photoKey ? `/api/files/${employee!.photoKey}` : null,
    facePhotoUrl: employee!.facePhotoKey ? `/api/files/${employee!.facePhotoKey}` : null,
    faceEnrolled: employee!.faceEnrolledAt != null,
    // Masked by default. The raw values never travel unless someone asks.
    identifiers: seesSensitive
      ? {
          pan: maskTail(decryptOptional(employee!.panCipher)),
          aadhaar: maskTail(decryptOptional(employee!.aadhaarCipher)),
          bankAccount: maskTail(decryptOptional(employee!.bankAccountCipher)),
          bankName: decryptOptional(employee!.bankNameCipher),
          ifsc: decryptOptional(employee!.bankIfscCipher),
        }
      : null,
    salary: seesSensitive
      ? (employee!.salaryProfiles[0] ?? null)
      : null,
  };
}

export interface HeadcountSummary {
  total: number;
  active: number;
  billable: number;
  byState: { state: EmploymentState; count: number }[];
  byDepartment: { department: string; count: number }[];
  faceEnrolled: number;
}
