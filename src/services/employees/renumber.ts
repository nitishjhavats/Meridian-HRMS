import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite } from "@/lib/auth/guard";
import { ConflictError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { formatEmployeeCode, normaliseCodePrefix } from "@/domain/employees/code";

/**
 * Move a whole directory onto the organisation's own code prefix.
 *
 * Nothing in the database keys on an employee code — attendance, payroll,
 * letters and documents all key on `Employee.id` — so this cannot break
 * history. What it *can* do is make a payslip somebody already holds disagree
 * with the directory, because that PDF was rendered with the old code baked
 * into it. That is the whole risk, it is stated on the screen before anything
 * runs, and it is why this is a deliberate action rather than something a
 * migration did quietly.
 *
 * Order is by joining date, so the oldest employee is 001. Alphabetical would
 * renumber everybody again the moment somebody's name was corrected.
 */

export interface RenumberRow {
  employeeId: string;
  name: string;
  from: string;
  to: string;
  /** True when the code is already what it would become. */
  unchanged: boolean;
}

export interface RenumberPlan {
  prefix: string;
  rows: RenumberRow[];
  changing: number;
}

async function planFor(ctx: AuthContext, prefix: string): Promise<RenumberPlan> {
  const employees = await prisma.employee.findMany({
    where: { organizationId: ctx.organizationId! },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, joiningDate: true },
    // Deterministic to the last field: two people who joined on the same day
    // must not swap numbers between the preview and the run.
    orderBy: [{ joiningDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const rows = employees.map((e, index) => {
    const to = formatEmployeeCode(prefix, index + 1);
    return {
      employeeId: e.id,
      name: [e.firstName, e.lastName].filter(Boolean).join(" "),
      from: e.employeeCode,
      to,
      unchanged: e.employeeCode === to,
    };
  });

  return { prefix, rows, changing: rows.filter((r) => !r.unchanged).length };
}

/** What would change, without changing it. */
export async function previewRenumber(ctx: AuthContext, prefix?: string): Promise<RenumberPlan> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.update");

  const org = await prisma.organization.findUnique({
    where: { id: ctx.organizationId! },
    select: { employeeCodePrefix: true },
  });
  return planFor(ctx, normaliseCodePrefix(prefix ?? org?.employeeCodePrefix ?? "EMP"));
}

/**
 * Apply the plan.
 *
 * Every code moves in one transaction, and it is done in two passes: first onto
 * a temporary code, then onto the real one. A single pass hits
 * `@@unique([organizationId, employeeCode])` the moment two people swap places
 * in the ordering — which happens whenever a joining date was corrected — and
 * the whole run fails on a constraint rather than on anything meaningful.
 */
export async function renumberEmployees(
  ctx: AuthContext,
  input: { prefix?: string; expectedChanging: number },
): Promise<{ changed: number; rows: RenumberRow[] }> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.update");

  const plan = await previewRenumber(ctx, input.prefix);

  // The screen showed a number and the person agreed to it. If the directory
  // moved underneath them, they should look again rather than have this run
  // against a set they never saw.
  if (plan.changing !== input.expectedChanging) {
    throw new ConflictError(
      "The directory changed since you looked. Check the preview again before running this.",
    );
  }

  const changing = plan.rows.filter((r) => !r.unchanged);
  if (changing.length === 0) return { changed: 0, rows: [] };

  await prisma.$transaction(async (tx) => {
    for (const row of changing) {
      await tx.employee.update({
        where: { id: row.employeeId },
        // Long enough that it cannot collide with a real code, and obviously
        // temporary if a transaction ever did leave one behind.
        data: { employeeCode: `~renumber~${row.employeeId}` },
      });
    }
    for (const row of changing) {
      await tx.employee.update({
        where: { id: row.employeeId },
        data: { employeeCode: row.to },
      });
    }
  });

  await writeAudit(ctx, {
    action: "employee.renumbered",
    entityType: "Organization",
    entityId: ctx.organizationId!,
    after: {
      prefix: plan.prefix,
      changed: changing.length,
      // The mapping itself, so an old payslip can always be traced to a person.
      mapping: changing.map((r) => ({ from: r.from, to: r.to })),
    },
  });

  return { changed: changing.length, rows: changing };
}
