import { z } from "zod";
import { EMPLOYEE_LOGIN_ROLES } from "@/domain/employees/loginRoles";

/**
 * The wire shape of an employee.
 *
 * It lives here rather than beside the route because Next only permits a route
 * file to export request handlers and a short list of config values — exporting
 * a schema from one fails the production build with an error `tsc` does not
 * raise. Both `/api/employees` and `/api/employees/[id]` import it from here.
 */

const optionalDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.")
  .optional()
  .nullable();

export const employeeSchema = z.object({
  employeeCode: z.string().trim().min(1).max(32),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).optional().nullable(),
  joiningDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
  workEmail: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal("")),
  personalEmail: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal("")),
  phone: z.string().trim().max(20).optional().nullable(),
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNDISCLOSED"]).optional().nullable(),
  dateOfBirth: optionalDate,
  employmentType: z.enum(["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN", "CONSULTANT"]).optional(),
  /** When training or probation ends and they become permanent. */
  confirmationDate: optionalDate,
  workMode: z.enum(["ONSITE", "REMOTE", "HYBRID"]).optional(),
  employmentState: z
    .enum(["TRAINING", "PROBATION", "REGULAR", "CONFIRMED", "NOTICE_PERIOD"])
    .optional(),
  departmentId: z.string().optional().nullable(),
  designationId: z.string().optional().nullable(),
  workLocationId: z.string().optional().nullable(),
  shiftId: z.string().optional().nullable(),
  weeklyOffPatternId: z.string().optional().nullable(),
  /**
   * Their own rest days, when they differ from every pattern. Null is "as the
   * pattern says". The days are only typed as numbers here: the range, the
   * empty list and the all-seven case are refused by `updateEmployee` with a
   * message a person can act on, not by a schema path.
   */
  weeklyOffConfig: z
    .object({
      type: z.enum(["FIXED", "MULTIPLE"]),
      days: z.array(z.number().int()).max(7),
    })
    .optional()
    .nullable(),
  /** Their own paid week-off quota a month. Null falls through to the designation. */
  weekOffsPerMonth: z.number().int().min(0).max(31).optional().nullable(),
  reportsToEmployeeId: z.string().optional().nullable(),
  /**
   * Annual cost to company, in paise. Asked at onboarding because that is when
   * it is agreed, and stored as the monthly figure the engine reads -- there is
   * one source of truth for pay and it is `SalaryProfile.ctcMonthlyPaise`.
   */
  annualCtcPaise: z.number().int().min(0).max(100_000_000_000).optional().nullable(),
  // Tri-state on purpose: null is "follow the organisation", which is different
  // from an explicit false.
  allowSelfMarking: z.boolean().optional().nullable(),
  addressLine1: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(80).optional().nullable(),
  state: z.string().trim().max(80).optional().nullable(),
  postalCode: z.string().trim().max(12).optional().nullable(),
  emergencyName: z.string().trim().max(80).optional().nullable(),
  emergencyPhone: z.string().trim().max(20).optional().nullable(),
  emergencyRelation: z.string().trim().max(40).optional().nullable(),
  bloodGroup: z.string().trim().max(8).optional().nullable(),
  // Encrypted before storage and never returned in full.
  pan: z.string().trim().max(20).optional().nullable(),
  aadhaar: z.string().trim().max(20).optional().nullable(),
  bankName: z.string().trim().max(80).optional().nullable(),
  bankAccount: z.string().trim().max(40).optional().nullable(),
  bankIfsc: z.string().trim().max(20).optional().nullable(),
  uan: z.string().trim().max(20).optional().nullable(),
});

/**
 * Whether to create a login alongside the employee, and with what role.
 *
 * Separate from the employee shape because it is not a property of the person —
 * it is an action taken at the moment of creating them, and the response carries
 * a password that is shown once and never returned again.
 */
export const loginOptionSchema = z
  .object({
    create: z.boolean().default(false),
    role: z.enum(EMPLOYEE_LOGIN_ROLES).optional(),
  })
  .default({ create: false });

export const createEmployeeSchema = employeeSchema.extend({ login: loginOptionSchema.optional() });

