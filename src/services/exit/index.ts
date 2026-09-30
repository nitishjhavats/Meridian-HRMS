import type { ExitStatus, ExitType, TaskStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/uniqueViolation";
import { outstandingFor } from "@/services/assets";
import { setEmployeeLoginActive } from "@/services/employees/access";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { type DateOnly, diffDays, todayInZone } from "@/domain/date";

/**
 * Exits.
 *
 * An exit is opened once per employee — the model enforces it — and then moves
 * INITIATED → NOTICE_PERIOD → CLEARANCE → SETTLED. The settlement itself lives
 * in `./fnf.ts`; this file is about the process around it: dates, notice, and
 * the list of things that must be handed back before money changes hands.
 *
 * The employee is *not* deactivated when an exit is opened. They keep working
 * through their notice period, and their seat stays billable until the last
 * working day actually passes — anything else would quietly stop their pay.
 */

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/**
 * Where somebody lands once the exit completes.
 *
 * There is no "EXITED" state — the reason they left is part of the record, and
 * a resignation and a termination are different facts about a person.
 */
const FINAL_STATE: Record<ExitType, "RESIGNED" | "TERMINATED" | "INACTIVE"> = {
  RESIGNATION: "RESIGNED",
  TERMINATION: "TERMINATED",
  ABSCONDING: "TERMINATED",
  RETIREMENT: "INACTIVE",
  END_OF_CONTRACT: "INACTIVE",
};

/** What clearance normally involves, so a new exit does not start empty. */
const DEFAULT_CHECKLIST = [
  { title: "Return laptop and accessories", sortOrder: 1 },
  { title: "Return ID card and access cards", sortOrder: 2 },
  { title: "Hand over ongoing work and documentation", sortOrder: 3 },
  { title: "Revoke system and email access", sortOrder: 4 },
  { title: "Clear pending expense claims", sortOrder: 5 },
  { title: "Exit interview", sortOrder: 6 },
];

export interface InitiateExitInput {
  employeeId: string;
  type: ExitType;
  resignationDate: DateOnly;
  lastWorkingDay: DateOnly;
  noticeDaysRequired?: number;
  reason?: string;
}

export async function initiateExit(ctx: AuthContext, input: InitiateExitInput) {
  requireOrg(ctx);
  requireWrite(ctx, "exit.manage", "exit");

  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, organizationId: ctx.organizationId },
    select: {
      id: true,
      userId: true,
      employeeCode: true,
      employmentState: true,
      firstName: true,
      lastName: true,
      user: { select: { name: true } },
    },
  });
  if (!employee) throw new NotFoundError("That employee");

  const existing = await prisma.exitRecord.findUnique({
    where: { employeeId: input.employeeId },
    select: { id: true, status: true, settlement: { select: { status: true, paidPaise: true } } },
  });
  if (existing && existing.status !== "CANCELLED") {
    throw new ConflictError("An exit is already open for that employee.");
  }

  /**
   * A settlement money went out on stays where it can be found.
   *
   * Reopening cuts the old settlement loose so the new exit can calculate its
   * own (below), and nothing in the product reaches a settlement except
   * through its exit — the list, the page, the statement PDF all start from
   * `exitRecord.settlement`. Cut loose, a paid one would be on no screen at
   * all: the statement the person was given, the amount recorded against it,
   * gone. So an exit that was paid out and then cancelled rather than closed
   * is not reopened; the money is still on the cancelled exit, which the page
   * shows. A partly paid one counts — it is the payment that matters, not
   * the status word.
   */
  if (
    existing?.settlement &&
    (existing.settlement.status === "PAID" || existing.settlement.paidPaise > 0)
  ) {
    throw new ConflictError(
      "That employee's earlier exit was cancelled after its settlement was paid, so a new one cannot be started; the paid statement is on the cancelled exit.",
    );
  }

  if (input.lastWorkingDay < input.resignationDate) {
    throw new ValidationError("The last working day cannot be before the resignation date.");
  }

  // Notice length is a term of the individual contract, not a column on the
  // employee, so it comes in with the request.
  const required = input.noticeDaysRequired ?? 0;
  const served = Math.max(0, diffDays(input.resignationDate, input.lastWorkingDay));
  const shortfall = Math.max(0, required - served);

  const fields = {
    type: input.type,
    status: "NOTICE_PERIOD" as const,
    resignationDate: toDate(input.resignationDate),
    lastWorkingDay: toDate(input.lastWorkingDay),
    noticeDaysRequired: required,
    noticeDaysServed: served,
    noticeShortfallDays: shortfall,
    reason: input.reason?.trim() || null,
    createdById: ctx.userId,
  };

  let record: { id: string };
  try {
    record = await prisma.$transaction(async (tx) => {
      if (!existing) {
        return tx.exitRecord.create({
          data: {
            organizationId: ctx.organizationId,
            employeeId: input.employeeId,
            ...fields,
            checklist: { create: DEFAULT_CHECKLIST },
          },
          select: { id: true },
        });
      }

      /**
       * A cancelled exit being reopened: reuse the row rather than leaving a
       * dead one behind, since the model allows only one per employee.
       *
       * Reusing the row used to mean reusing everything on it. Somebody who
       * withdrew a resignation after handing back their laptop came back
       * months later to a clearance list already ticked, and to the
       * settlement calculated for the exit that never happened — the "Calculate"
       * button was gone because a figure already existed. The new exit starts
       * as a new one would: a fresh list, and no settlement. The old figure is
       * cancelled, approved or not: it priced an exit that did not happen, and
       * nothing was paid on it — a paid one stops the reopen above. Cancelled
       * *and* cut loose, because `calculateFnf` finds a settlement by its
       * exit, and a cancelled one still attached would answer that lookup and
       * refuse the new calculation for good.
       */
      await tx.exitChecklistItem.deleteMany({ where: { exitRecordId: existing.id } });
      await tx.fnfSettlement.updateMany({
        where: { exitRecordId: existing.id, status: { in: ["DRAFT", "CALCULATED", "APPROVED"] } },
        data: { status: "CANCELLED" },
      });
      await tx.fnfSettlement.updateMany({
        where: { exitRecordId: existing.id },
        data: { exitRecordId: null },
      });
      return tx.exitRecord.update({
        where: { id: existing.id },
        data: { ...fields, exitInterviewNote: null, checklist: { create: DEFAULT_CHECKLIST } },
        select: { id: true },
      });
    });
  } catch (error) {
    // Two people starting the same exit at once: the second create trips the
    // one-per-employee constraint, which is the same answer as the check above.
    if (isUniqueViolation(error)) {
      throw new ConflictError("An exit is already open for that employee.");
    }
    throw error;
  }

  await prisma.$transaction([
    prisma.employee.update({
      where: { id: input.employeeId },
      data: { employmentState: "NOTICE_PERIOD", exitDate: toDate(input.lastWorkingDay) },
    }),
    // Written so that cancelling an exit can restore what they were before,
    // rather than guessing at a state.
    prisma.employmentStateChange.create({
      data: {
        employeeId: input.employeeId,
        fromState: employee.employmentState,
        toState: "NOTICE_PERIOD",
        effectiveOn: toDate(input.resignationDate),
        reason: input.reason?.trim() || `Exit initiated (${input.type})`,
        actorId: ctx.userId,
      },
    }),
  ]);

  await writeAudit(ctx, {
    action: "exit.initiated",
    entityType: "ExitRecord",
    entityId: record.id,
    after: {
      employeeCode: employee.employeeCode,
      type: input.type,
      lastWorkingDay: input.lastWorkingDay,
      noticeShortfallDays: shortfall,
    },
  });

  await notify.toOrgRoles(ctx.organizationId, ["HR_MANAGER", "ADMIN", "ORG_OWNER"], {
    type: "exit.initiated",
    title: "Exit started",
    body: `${employee.user?.name ?? employee.employeeCode} leaves on ${input.lastWorkingDay}.`,
    link: `/exit/${record.id}`,
  });

  return { id: record.id, noticeShortfallDays: shortfall };
}

// ------------------------------------------------------------------ listing

export interface ExitRow {
  id: string;
  type: ExitType;
  status: ExitStatus;
  resignationDate: DateOnly;
  lastWorkingDay: DateOnly;
  noticeDaysRequired: number;
  noticeDaysServed: number;
  noticeShortfallDays: number;
  reason: string | null;
  /** Negative once the last working day has passed. */
  daysRemaining: number;
  employee: { id: string; name: string; code: string; designation: string | null };
  checklist: { total: number; done: number };
  settlement: { id: string; status: string; netPaise: number } | null;
}

export async function listExits(
  ctx: AuthContext,
  filters: { status?: ExitStatus } = {},
): Promise<ExitRow[]> {
  requireOrg(ctx);

  const visible = await visibleEmployeeIds(ctx, "employee.read");
  const where: Record<string, unknown> = { organizationId: ctx.organizationId };
  if (visible !== null) where.employeeId = { in: visible };
  if (filters.status) where.status = filters.status;

  const records = await prisma.exitRecord.findMany({
    where,
    orderBy: [{ status: "asc" }, { lastWorkingDay: "asc" }],
    take: 200,
    select: {
      id: true,
      type: true,
      status: true,
      resignationDate: true,
      lastWorkingDay: true,
      noticeDaysRequired: true,
      noticeDaysServed: true,
      noticeShortfallDays: true,
      reason: true,
      employee: {
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          user: { select: { name: true } },
          designation: { select: { title: true } },
        },
      },
      checklist: { select: { status: true } },
      settlement: { select: { id: true, status: true, netPaise: true } },
    },
  });

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");

  return records.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    resignationDate: toDateOnly(r.resignationDate),
    lastWorkingDay: toDateOnly(r.lastWorkingDay),
    noticeDaysRequired: r.noticeDaysRequired,
    noticeDaysServed: r.noticeDaysServed,
    noticeShortfallDays: r.noticeShortfallDays,
    reason: r.reason,
    daysRemaining: diffDays(today, toDateOnly(r.lastWorkingDay)),
    employee: {
      id: r.employee.id,
      name: employeeName(r.employee, "—"),
      code: r.employee.employeeCode,
      designation: r.employee.designation?.title ?? null,
    },
    checklist: {
      total: r.checklist.length,
      done: r.checklist.filter((c) => c.status === "COMPLETED" || c.status === "SKIPPED").length,
    },
    settlement: r.settlement
      ? { id: r.settlement.id, status: r.settlement.status, netPaise: r.settlement.netPaise }
      : null,
  }));
}

export async function getExit(ctx: AuthContext, id: string) {
  requireOrg(ctx);

  const record = await prisma.exitRecord.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      employee: {
        select: {
          id: true,
          employeeCode: true,
          joiningDate: true,
          // Read off the employee record, not the login. Somebody may have no
          // account at all, and their name is a property of the person.
          firstName: true,
          lastName: true,
          workEmail: true,
          personalEmail: true,
          user: { select: { email: true } },
          designation: { select: { title: true } },
          department: { select: { name: true } },
        },
      },
      checklist: { orderBy: { sortOrder: "asc" } },
      settlement: { include: { lines: { orderBy: { sortOrder: "asc" } } } },
    },
  });
  if (!record) throw new NotFoundError("That exit");

  // Out-of-scope reads look identical to "does not exist".
  const visible = await visibleEmployeeIds(ctx, "employee.read");
  if (visible !== null && !visible.includes(record.employeeId)) {
    throw new NotFoundError("That exit");
  }

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");

  /**
   * Company property they still hold.
   *
   * `outstandingFor` has existed in the assets module since it was written and
   * is called from nowhere, so the exit screens never mentioned assets at all —
   * somebody could be settled and paid while still holding a laptop, and the
   * only record of it was in a module nobody opens during an exit. Read here,
   * beside the clearance list, which is where the question is actually asked.
   */
  const outstandingAssets = await outstandingFor(ctx, record.employeeId);

  return {
    ...record,
    outstandingAssets,
    resignationDate: toDateOnly(record.resignationDate),
    lastWorkingDay: toDateOnly(record.lastWorkingDay),
    daysRemaining: diffDays(today, toDateOnly(record.lastWorkingDay)),
    employee: {
      ...record.employee,
      name: [record.employee.firstName, record.employee.lastName].filter(Boolean).join(" "),
      email:
        record.employee.workEmail ??
        record.employee.personalEmail ??
        record.employee.user?.email ??
        null,
      joiningDate: record.employee.joiningDate ? toDateOnly(record.employee.joiningDate) : null,
    },
    checklist: record.checklist.map((c) => ({
      ...c,
      dueOn: c.dueOn ? toDateOnly(c.dueOn) : null,
      completedAt: c.completedAt?.toISOString() ?? null,
    })),
  };
}

// ------------------------------------------------------------------ checklist

export async function setChecklistItem(
  ctx: AuthContext,
  itemId: string,
  status: TaskStatus,
  note?: string,
) {
  requireOrg(ctx);
  requireWrite(ctx, "exit.manage", "exit");

  const item = await prisma.exitChecklistItem.findFirst({
    where: { id: itemId, exitRecord: { organizationId: ctx.organizationId } },
    select: { id: true, title: true, exitRecordId: true },
  });
  if (!item) throw new NotFoundError("That checklist item");

  const done = status === "COMPLETED" || status === "SKIPPED";

  await prisma.exitChecklistItem.update({
    where: { id: itemId },
    data: {
      status,
      note: note?.trim() || null,
      completedAt: done ? new Date() : null,
      completedById: done ? ctx.userId : null,
    },
  });

  return { id: itemId, status };
}

export async function addChecklistItem(ctx: AuthContext, exitRecordId: string, title: string) {
  requireOrg(ctx);
  requireWrite(ctx, "exit.manage", "exit");

  const record = await prisma.exitRecord.findFirst({
    where: { id: exitRecordId, organizationId: ctx.organizationId },
    select: { id: true, checklist: { select: { sortOrder: true } } },
  });
  if (!record) throw new NotFoundError("That exit");

  const next = Math.max(0, ...record.checklist.map((c) => c.sortOrder)) + 1;
  const item = await prisma.exitChecklistItem.create({
    data: { exitRecordId, title: title.trim(), sortOrder: next },
  });

  return { id: item.id };
}

// ------------------------------------------------------------------ status

export async function setExitStatus(ctx: AuthContext, id: string, status: ExitStatus, note?: string) {
  requireOrg(ctx);
  requireWrite(ctx, "exit.manage", "exit");
  // Closing ends the employment and disables the login. That is the settle
  // permission's business — its description says so — and it is what the
  // page shows the button under, so the service asks for the same thing.
  if (status === "SETTLED") requireWrite(ctx, "exit.settle", "exit");

  const record = await prisma.exitRecord.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: {
      checklist: { select: { status: true } },
      settlement: { select: { status: true } },
      employee: { select: { id: true, userId: true } },
    },
  });
  if (!record) throw new NotFoundError("That exit");

  if (status === "CLEARANCE") {
    const pending = record.checklist.filter((c) => c.status === "PENDING" || c.status === "IN_PROGRESS");
    if (pending.length > 0) {
      throw new ValidationError(
        `${pending.length} clearance item(s) are still open. Complete or skip them first.`,
      );
    }
  }

  if (status === "SETTLED" && record.settlement?.status !== "PAID") {
    throw new ValidationError(
      "The final settlement has not been paid yet, so this exit cannot be closed.",
    );
  }

  await prisma.exitRecord.update({
    where: { id },
    data: { status, ...(note !== undefined ? { exitInterviewNote: note.trim() || null } : {}) },
  });

  // Only at the very end does the person stop being an employee — and with it,
  // stop consuming a paid seat.
  if (status === "SETTLED") {
    const finalState = FINAL_STATE[record.type];
    await prisma.$transaction(async (tx) => {
      const employee = await tx.employee.update({
        where: { id: record.employeeId },
        data: { active: false, employmentState: finalState },
        select: { userId: true },
      });

      await tx.employmentStateChange.create({
        data: {
          employeeId: record.employeeId,
          fromState: "NOTICE_PERIOD",
          toState: finalState,
          effectiveOn: record.lastWorkingDay,
          reason: "Exit settled",
          actorId: ctx.userId,
        },
      });

      /**
       * And they lose their key.
       *
       * This path did not do it. `changeEmploymentState` has always disabled
       * the login on the way out, but nothing calls that from any screen — the
       * exit module is how people actually leave, and it only ever deactivated
       * the *employee*. So a settled leaver kept a working password and a live
       * session, and could sign back in and read whatever their role allowed.
       * Impossible before employees had logins; created the day they got them.
       */
      await setEmployeeLoginActive(tx, employee, { active: false, actorId: ctx.userId });
    });
  }

  await writeAudit(ctx, {
    action: status === "SETTLED" ? "exit.settled" : "exit.initiated",
    entityType: "ExitRecord",
    entityId: id,
    before: { status: record.status },
    after: { status },
  });

  return { id, status };
}

export async function cancelExit(ctx: AuthContext, id: string, reason?: string) {
  requireOrg(ctx);
  requireWrite(ctx, "exit.manage", "exit");

  const record = await prisma.exitRecord.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, status: true, employeeId: true },
  });
  if (!record) throw new NotFoundError("That exit");
  if (record.status === "SETTLED") {
    throw new ConflictError("A settled exit cannot be cancelled.");
  }

  await prisma.exitRecord.update({
    where: { id },
    data: { status: "CANCELLED", reason: reason?.trim() || null },
  });

  // Somebody who withdraws a resignation goes back to whatever they were —
  // read from history, because a trainee must not silently become confirmed.
  const previous = await prisma.employmentStateChange.findFirst({
    where: { employeeId: record.employeeId, toState: "NOTICE_PERIOD" },
    orderBy: { createdAt: "desc" },
    select: { fromState: true },
  });
  const restored = previous?.fromState ?? "CONFIRMED";

  await prisma.$transaction([
    prisma.employee.update({
      where: { id: record.employeeId },
      data: { employmentState: restored, exitDate: null, active: true },
    }),
    prisma.employmentStateChange.create({
      data: {
        employeeId: record.employeeId,
        fromState: "NOTICE_PERIOD",
        toState: restored,
        effectiveOn: new Date(),
        reason: reason?.trim() || "Exit cancelled",
        actorId: ctx.userId,
      },
    }),
  ]);

  await writeAudit(ctx, {
    action: "exit.initiated",
    entityType: "ExitRecord",
    entityId: id,
    before: { status: record.status },
    after: { status: "CANCELLED", reason: reason?.trim() || null },
  });

  return { id, status: "CANCELLED" as const };
}
