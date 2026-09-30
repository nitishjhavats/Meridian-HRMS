import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite } from "@/lib/auth/guard";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { canActivateEmployee } from "@/domain/billing/seats";
import { parseCsv } from "@/domain/csv";
import {
  EMPLOYEE_IMPORT_COLUMNS,
  importColumnGuide,
  lookupKey,
  planEmployeeImport,
  type ImportLookups,
  type ImportPlan,
  type ImportRow,
  type TemplateReference,
} from "@/domain/employees/import";
import { isEmployeeLoginRole } from "@/domain/employees/loginRoles";
import { resolveWorkLocationId } from "@/domain/org/defaultWorkLocation";
import { insertEmployee } from "./write";
import { employeeSchema } from "./schema";
import { attachReportingLine } from "@/services/org/structure";
import { saveSalaryProfile } from "@/services/payroll/salaryStructure";
import { notify } from "@/lib/notify";
import {
  provisionEmployeeLogin,
  type EmployeeLoginRole,
  type IssuedCredential,
} from "./credentials";

/**
 * Loading a spreadsheet of employees.
 *
 * Two calls, and the split between them is the point: `preview` never writes,
 * and `commit` never trusts what preview returned. The browser sends the file
 * again and the whole plan is rebuilt server-side, because a client that could
 * hand back "these rows are fine, create them" would be handing back employee
 * records of its own design — including, say, an employee code that belongs to
 * somebody else's tenant.
 *
 * The commit runs in one transaction. A bulk import that half-succeeds into a
 * payroll system is worse than one that refuses: nobody can tell by looking
 * which half landed.
 */

export interface ImportPreview extends ImportPlan {
  /** Free seats at the moment of the preview, or null when uncapped. */
  seatsRemaining: number | null;
  /** Names the file may refer to, so the screen can list what exists. */
  known: {
    departments: string[];
    designations: string[];
    workLocations: string[];
    shifts: string[];
    weeklyOffPatterns: string[];
  };
}

/** Both entry points read the organisation the same way. */
async function loadLookups(organizationId: string): Promise<{
  lookups: ImportLookups;
  known: ImportPreview["known"];
  /** Employee code (lowercased) to id, for resolving the manager column. */
  employeeIdsByCode: Map<string, string>;
}> {
  const [departments, designations, workLocations, shifts, patterns, employees] =
    await Promise.all([
      prisma.department.findMany({ where: { organizationId }, select: { id: true, name: true } }),
      prisma.designation.findMany({ where: { organizationId }, select: { id: true, title: true } }),
      prisma.workLocation.findMany({ where: { organizationId }, select: { id: true, name: true } }),
      prisma.shift.findMany({ where: { organizationId }, select: { id: true, name: true } }),
      prisma.weeklyOffPattern.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
      prisma.employee.findMany({
        where: { organizationId },
        select: { id: true, employeeCode: true },
      }),
    ]);

  const byName = (rows: { id: string; name: string }[]) =>
    new Map(rows.map((r) => [lookupKey(r.name), r.id]));

  // Designations call their label `title`, so they are mapped separately rather
  // than being quietly reshaped into something they are not.
  const designationsByName = new Map(designations.map((d) => [lookupKey(d.title), d.id]));

  return {
    lookups: {
      departments: byName(departments),
      designations: designationsByName,
      workLocations: byName(workLocations),
      shifts: byName(shifts),
      weeklyOffPatterns: byName(patterns),
      existingCodes: new Set(employees.map((e) => e.employeeCode.toLowerCase())),
    },
    known: {
      departments: departments.map((d) => d.name),
      designations: designations.map((d) => d.title),
      workLocations: workLocations.map((l) => l.name),
      shifts: shifts.map((s) => s.name),
      weeklyOffPatterns: patterns.map((p) => p.name),
    },
    employeeIdsByCode: new Map(employees.map((e) => [e.employeeCode.toLowerCase(), e.id])),
  };
}

/**
 * What the import screen needs before anybody has chosen a file: the columns,
 * and the names this organisation will accept in the five reference columns.
 *
 * All of this already existed and none of it was reachable. The hints have been
 * on the columns since the importer was written and were rendered nowhere, so
 * the allowed values for Gender, Employment Type, Work Mode and Employment State
 * could only be discovered by getting them wrong and reading the refusal.
 */
export async function employeeImportGuide(ctx: AuthContext) {
  requireOrg(ctx);
  requireWrite(ctx, "employee.create");
  const { known } = await loadLookups(ctx.organizationId!);
  return { columns: importColumnGuide(), known };
}

/**
 * The first of each reference the organisation has, for the template's example
 * rows. Empty for a brand-new organisation, and those cells are then left blank
 * rather than naming something that does not exist -- the file is meant to be
 * importable exactly as it downloads.
 */
export async function templateReference(ctx: AuthContext): Promise<TemplateReference> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.create");
  const { known } = await loadLookups(ctx.organizationId!);
  const first = (values: string[]) => values[0];
  return {
    ...(first(known.departments) ? { department: first(known.departments)! } : {}),
    ...(first(known.designations) ? { designation: first(known.designations)! } : {}),
    ...(first(known.workLocations) ? { workLocation: first(known.workLocations)! } : {}),
    ...(first(known.shifts) ? { shift: first(known.shifts)! } : {}),
    ...(first(known.weeklyOffPatterns)
      ? { weeklyOffPattern: first(known.weeklyOffPatterns)! }
      : {}),
  };
}

/**
 * How many more people this organisation may take on.
 *
 * `canActivateEmployee` answers one at a time; a file needs the number. Null
 * means uncapped, which is what a free internal organisation gets.
 */
async function seatsRemaining(ctx: AuthContext): Promise<number | null> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId: ctx.organizationId! },
    select: { seats: true, billingMode: true, graceUntil: true },
  });
  if (!subscription) return 0;
  if (subscription.billingMode === "FREE_INTERNAL") return null;

  const activeEmployees = await prisma.employee.count({
    where: { organizationId: ctx.organizationId!, active: true },
  });

  const decision = canActivateEmployee({
    seats: subscription.seats,
    activeEmployees,
    billingMode: subscription.billingMode,
    graceUntil: subscription.graceUntil,
    now: new Date(),
  });

  return decision.seatsRemaining === Number.POSITIVE_INFINITY
    ? null
    : Math.max(0, subscription.seats - activeEmployees);
}

function parseOrThrow(csv: string) {
  const parsed = parseCsv(csv);
  if (!parsed.ok) throw new ValidationError(parsed.message);
  return parsed.table;
}

export async function previewEmployeeImport(
  ctx: AuthContext,
  csv: string,
): Promise<ImportPreview> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.create");

  const table = parseOrThrow(csv);
  const [{ lookups, known }, remaining] = await Promise.all([
    loadLookups(ctx.organizationId!),
    seatsRemaining(ctx),
  ]);

  const plan = planEmployeeImport(table, lookups, { seatsRemaining: remaining });
  return { ...plan, seatsRemaining: remaining, known };
}

export interface ImportResult {
  created: number;
  skipped: number;
  /**
   * One row per login that was minted, each carrying a password shown exactly
   * once. Empty unless the caller asked for logins.
   *
   * These never touch the database in plaintext and cannot be fetched again.
   * The screen turns them into a CSV the administrator hands out, and that file
   * is the only copy that will ever exist.
   */
  credentials: IssuedCredential[];
  /** How many opening salary profiles were written from the Annual CTC column. */
  salariesSet: number;
  /** How many reporting lines were attached from the Reports To column. */
  managersLinked: number;
  /**
   * Anything that could not be done *after* the rows were written.
   *
   * The employees are in, because these three -- the salary profile, the
   * reporting line, the notification -- each run outside the import
   * transaction and each is recoverable from the product. Silently dropping
   * them would leave somebody believing a manager was set when it was not.
   */
  warnings: string[];
}

/**
 * Everything the commit decides before it touches the database.
 *
 * Three refusals and two numbers, none of which need a connection to reach. The
 * one that earns its own name is the middle one: `skipRowsWithErrors` has to be
 * asked for. A file with bad rows is refused by default, because the
 * alternative — importing the good half and reporting success — leaves an
 * administrator believing a payroll system knows about people it has never
 * heard of.
 */
export type ImportCommitDecision =
  | { ok: false; refusal: string }
  | { ok: true; ready: ImportRow[]; created: number; skipped: number };

export function decideImportCommit(
  plan: ImportPlan,
  options: { skipRowsWithErrors?: boolean } = {},
): ImportCommitDecision {
  if (plan.blocked) return { ok: false, refusal: plan.blocked };

  if (plan.errorCount > 0 && !options.skipRowsWithErrors) {
    return {
      ok: false,
      refusal: `${plan.errorCount} of ${plan.rows.length} rows have problems. Fix them and upload again, or choose to import only the rows that are ready.`,
    };
  }

  const ready = plan.rows.filter((r) => r.employee);
  if (ready.length === 0) {
    return { ok: false, refusal: "There is nothing in that file that can be imported." };
  }

  // The same schema every other way in has to satisfy.
  //
  // The importer used to hand its rows to `insertEmployee` as `input as never`,
  // which is a cast telling the compiler to stop asking -- so the length caps
  // that protect the form path were simply not enforced on the spreadsheet one.
  // A 4000-character address is not something the domain validator has an
  // opinion about, and it is not something a payslip can print either.
  for (const row of ready) {
    const parsed = employeeSchema.safeParse(row.employee);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const field = first?.path.join(".") || "a value";
      return {
        ok: false,
        refusal: `Line ${row.line}: ${field} ${first?.message ?? "is not acceptable"}.`,
      };
    }
  }

  return { ok: true, ready, created: ready.length, skipped: plan.errorCount };
}

export async function commitEmployeeImport(
  ctx: AuthContext,
  csv: string,
  options: {
    skipRowsWithErrors?: boolean;
    createLogins?: boolean;
    loginRole?: EmployeeLoginRole;
  } = {},
): Promise<ImportResult> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.create");

  // Rebuilt from the file, not taken from the browser. Whatever the preview
  // said a moment ago, this is the decision that counts.
  const table = parseOrThrow(csv);
  const [{ lookups, employeeIdsByCode }, remaining] = await Promise.all([
    loadLookups(ctx.organizationId!),
    seatsRemaining(ctx),
  ]);
  const plan = planEmployeeImport(table, lookups, { seatsRemaining: remaining });

  const decision = decideImportCommit(plan, options);
  if (!decision.ok) throw new ValidationError(decision.refusal);
  const ready = decision.ready;

  // One transaction for the whole file. If the last row collides with an
  // employee code created by somebody else a second ago, the unique index
  // aborts everything and the organisation is exactly as it was.
  const organizationSlug = ctx.organization?.slug ?? null;

  /**
   * The default branch, which the importer walked straight past.
   *
   * `createEmployee` fills a blank work location from the primary branch --
   * that is the whole of the round-6 geofence fix, because an employee with no
   * work location has no distance measured for them and can mark attendance
   * from anywhere. The importer calls `insertEmployee` directly, so a blank
   * "Work Location" cell resolved to `null` and stayed `null`. A file of fifty
   * people imported without that column is fifty people outside the fence, and
   * the screen that would have told you is the setup checklist nobody rereads.
   */
  const locations = await prisma.workLocation.findMany({
    where: { organizationId: ctx.organizationId! },
    select: { id: true, active: true, isPrimary: true, createdAt: true },
  });

  const { credentials, createdIds } = await prisma.$transaction(async (tx) => {
    const issued: IssuedCredential[] = [];
    const ids = new Map<string, string>();
    for (const row of ready) {
      const input = {
        ...row.employee!,
        workLocationId: resolveWorkLocationId(locations, row.employee!.workLocationId),
      };
      const state = (input.employmentState ?? "PROBATION") as never;
      const employee = await insertEmployee(tx, ctx, input as never, state);
      ids.set(input.employeeCode.toLowerCase(), employee.id);

      if (options.createLogins) {
        // A row with no email cannot have a login, and refusing the whole file
        // over it would be worse than importing the person without one — so the
        // employee lands and the credential list simply does not name them. The
        // screen reports the difference between rows created and logins issued.
        if (employee.workEmail || employee.personalEmail) {
          issued.push(
            await provisionEmployeeLogin(tx, ctx, employee, {
              // A row may name its own role; the switch on the screen is the
              // default for the rows that do not.
              role: rowLoginRole(row) ?? options.loginRole,
              organizationSlug,
            }),
          );
        }
      }
    }
    return { credentials: issued, createdIds: ids };
  });

  // Everything below runs *after* the transaction, and each of the three has to.
  //
  // `attachReportingLine` and `saveSalaryProfile` open transactions of their
  // own, and neither takes a client, so calling them inside the one above would
  // deadlock against it. The same reasoning `createEmployee` already gives:
  // an employee who exists without a manager is a state the product handles,
  // and an employee who does not exist because their manager could not be
  // attached is not.
  const warnings: string[] = [];
  const resolved = new Map([...employeeIdsByCode, ...createdIds]);

  let managersLinked = 0;
  for (const row of ready) {
    if (!row.reportsToCode) continue;
    const employeeId = createdIds.get(row.employee!.employeeCode.toLowerCase());
    const managerId = resolved.get(row.reportsToCode.toLowerCase());
    if (!employeeId || !managerId) continue;
    try {
      await attachReportingLine(ctx, {
        employeeId,
        managerId,
        startDate: row.employee!.joiningDate,
      });
      managersLinked++;
    } catch (error) {
      // A cycle is the realistic one: two rows naming each other as manager.
      warnings.push(
        `Line ${row.line}: ${row.name} was imported, but the manager could not be set — ${
          error instanceof Error ? error.message : "it was refused"
        }`,
      );
    }
  }

  // Pay is a narrower permission than creating people: `employee.create` is
  // held by HR, `employee.salary.manage` by Admins. The single-create route
  // makes exactly this check, and a spreadsheet must not be the way around it.
  let salariesSet = 0;
  const maySetPay = ctx.permissions.has("employee.salary.manage");
  const withPay = ready.filter((row) => row.annualCtcPaise !== undefined);
  if (withPay.length > 0 && !maySetPay) {
    warnings.push(
      `${withPay.length} row${withPay.length === 1 ? "" : "s"} carried an Annual CTC and it was not applied: setting pay needs the salary permission, which this account does not have.`,
    );
  } else {
    for (const row of withPay) {
      const employeeId = createdIds.get(row.employee!.employeeCode.toLowerCase());
      if (!employeeId) continue;
      try {
        await saveSalaryProfile(ctx, employeeId, {
          ctcMonthlyPaise: Math.round(row.annualCtcPaise! / 12),
          effectiveFrom: row.employee!.joiningDate,
          note: "Set when they were imported",
        });
        salariesSet++;
      } catch (error) {
        warnings.push(
          `Line ${row.line}: ${row.name} was imported, but their salary could not be set — ${
            error instanceof Error ? error.message : "it was refused"
          }`,
        );
      }
    }
  }

  // One notification for the file, not one per person. `createEmployee` sends
  // one each because it creates one each; doing the same for two hundred rows
  // would bury every other notification an HR manager has.
  const unmanaged = ready.length - managersLinked;
  if (unmanaged > 0) {
    await notify.toOrgRoles(ctx.organizationId!, ["HR_MANAGER", "ADMIN", "ORG_OWNER"], {
      type: "employee.no_manager",
      title:
        unmanaged === 1
          ? "Somebody was imported with no manager"
          : `${unmanaged} people were imported with no manager`,
      body: `Their leave and attendance corrections will come to you until a reporting line is set. The Reports To column in the import file sets it, or you can set it on each profile.`,
      link: `/employees`,
    });
  }

  await writeAudit(ctx, {
    action: "employee.imported",
    entityType: "Employee",
    metadata: {
      created: decision.created,
      skipped: decision.skipped,
      // Worth keeping: it distinguishes a clean load from one where somebody
      // knowingly left rows behind.
      skippedDeliberately: decision.skipped > 0,
      columnsIgnored: plan.unknownColumns,
      // The number, never the passwords. Whoever downloads a file of working
      // credentials should be answerable for it.
      loginsIssued: credentials.length,
      salariesSet,
      managersLinked,
      warnings,
    },
  });

  return {
    created: decision.created,
    skipped: decision.skipped,
    credentials,
    salariesSet,
    managersLinked,
    warnings,
  };
}

/** The role a row asked for, if it named one this product recognises. */
function rowLoginRole(row: ImportRow): EmployeeLoginRole | undefined {
  return isEmployeeLoginRole(row.loginRole) ? row.loginRole : undefined;
}
