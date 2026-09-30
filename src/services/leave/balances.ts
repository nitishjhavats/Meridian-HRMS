import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertSameTenant,
  requireModule,
  requireOrg,
  requirePermission,
  requireWrite,
} from "@/lib/auth/guard";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { type DateOnly, todayInZone } from "@/domain/date";
import {
  type LeaveBalanceState,
  accruedForRow,
  accruedSoFar,
  availableDays,
  carryForwardAmount,
} from "@/domain/leave";
import {
  allocationOverrides,
  designationAllocation,
  resolveAllocation,
} from "@/domain/leave/allocation";

/**
 * Leave balance administration.
 *
 * Two jobs, and both of them are about the same number: what somebody is
 * allowed to take. `leave/index.ts` moves that number in exactly one place — an
 * approval increments `used` — and nothing until now could set the other side
 * of it. So an opening balance was whatever `provisionTenant` happened to write,
 * a correction meant a hand-written UPDATE, and `carryForwardAmount` sat in the
 * domain, tested, called by nothing at all: every organisation's unused days
 * simply vanished at midnight on the 31st of December.
 *
 * The rule that shapes this file: **`used` is derived, never entered.** It is
 * the sum of approved leave and nothing else. An administrator who could type
 * over it would make the balance and the leave register disagree, with no way
 * afterwards to tell which of the two is lying. So the grid *reports* the
 * disagreement when it finds one — see `approved` on a cell — and the adjust
 * path refuses to touch it.
 *
 * The second rule: **the year-end run sets, it never increments.** Carry-forward
 * is computed from the closing position of the year that ended, so running it
 * twice writes the same figure twice. That is what makes it safe to re-run
 * after fixing a leave record, and it is why the writes are chunked rather than
 * wrapped in one enormous transaction — a run that dies halfway is finished by
 * running it again.
 */

/** Half a day is the smallest unit of leave anywhere in the product. */
const DAY_STEP = 0.5;

/** `Decimal(6,2)` holds 9999.99; a leave balance in the hundreds is already absurd. */
const MAX_DAYS = 999;

/**
 * Employees shown at once.
 *
 * The grid is employees × leave types, so a thousand-person organisation is
 * several thousand cells of nothing anybody is looking for. Past this the
 * screen asks for a filter rather than shipping the lot.
 */
const MAX_ROWS = 200;

/** How many upserts go in one transaction during the year-end run. */
const WRITE_CHUNK = 100;

/* -------------------------------------------------------------------------- */
/*  Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface BalanceTypeRow {
  id: string;
  code: string;
  name: string;
  color: string;
  paid: boolean;
  /** MONTHLY accrual: days are earned as the year passes, not granted up front. */
  accrues: boolean;
  annualAllocation: number;
  carryForward: boolean;
  maxCarryForward: number;
}

export interface BalanceCell {
  leaveTypeId: string;
  allocated: number;
  accrued: number;
  used: number;
  carriedForward: number;
  encashed: number;
  /** What is left to take, by the domain's own arithmetic. */
  available: number;
  /**
   * False when no `LeaveBalance` row exists yet, so these figures are the leave
   * type's defaults rather than anything anybody decided. Worth showing: an
   * administrator about to adjust a balance should know whether they are
   * editing a record or creating one.
   */
  stored: boolean;
  /**
   * Days of approved leave of this type in this year.
   *
   * `used` should equal this and occasionally does not — a balance edited
   * outside the product, or a row that predates the approval path. Surfacing
   * the disagreement is the whole reason the figure is here; nothing in this
   * service ever "fixes" it by writing `used`.
   */
  approved: number;
}

export interface BalanceRow {
  employeeId: string;
  employeeCode: string;
  name: string;
  department: string | null;
  cells: BalanceCell[];
  /**
   * The caller's own row. `adjustBalance` refuses it, so the grid shows the
   * figures and offers no control — a cell that opens a dialog whose only
   * possible outcome is a refusal teaches people to ignore refusals.
   */
  self: boolean;
}

export interface BalanceGrid {
  year: number;
  /** The organisation's own current year, which the year-end run counts back from. */
  thisYear: number;
  /** Years offered in the picker: the last three and the next. */
  years: number[];
  types: BalanceTypeRow[];
  rows: BalanceRow[];
  /** Everybody who could be filtered to, whatever the current filter shows. */
  employees: { id: string; code: string; name: string }[];
  filters: { employeeId: string | null; leaveTypeId: string | null };
  /** More people than `MAX_ROWS` matched, so the grid is a prefix of them. */
  truncated: boolean;
  total: number;
}

export interface BalanceFilters {
  year?: number;
  employeeId?: string;
  leaveTypeId?: string;
}

export async function listBalances(
  ctx: AuthContext,
  filters: BalanceFilters = {},
): Promise<BalanceGrid> {
  requireOrg(ctx);
  // A read, but not an ordinary one: this is every employee's entitlement side
  // by side, which is precisely what the manage permission exists to gate. No
  // `visibleEmployeeIds` scoping for the same reason — a Team Lead does not
  // hold this permission at all, and someone who does holds it organisation-wide.
  requirePermission(ctx, "leave.balance.manage");
  // The write path already refuses with the module off; a read that did not
  // would leave the grid legible for an organisation that has switched leave
  // away, with every control on it refusing.
  requireModule(ctx, "leave");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const thisYear = Number(today.slice(0, 4));
  const year = filters.year ?? thisYear;

  const [types, everybody, allocationRows] = await Promise.all([
    prisma.leaveType.findMany({
      where: { organizationId: ctx.organizationId, active: true },
      orderBy: { code: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        color: true,
        paid: true,
        accrualMode: true,
        annualAllocation: true,
        monthlyAccrual: true,
        carryForward: true,
        maxCarryForward: true,
      },
    }),
    prisma.employee.findMany({
      // Somebody who joined in a later year has no balance for this one, and a
      // row of zeroes for them is noise an administrator has to read past.
      where: {
        organizationId: ctx.organizationId,
        active: true,
        joiningDate: { lte: endOfYear(year) },
      },
      orderBy: { employeeCode: "asc" },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        joiningDate: true,
        designationId: true,
        department: { select: { name: true } },
      },
    }),
    // How many days each designation gets of each type. Small -- one row per
    // deliberate exception -- and needed before any cell can be worked out.
    prisma.designationLeaveAllocation.findMany({
      where: { organizationId: ctx.organizationId },
      select: { leaveTypeId: true, designationId: true, annualAllocation: true },
    }),
  ]);
  const overrides = allocationOverrides(allocationRows);

  const shownTypes = filters.leaveTypeId
    ? types.filter((t) => t.id === filters.leaveTypeId)
    : types;
  const matching = filters.employeeId
    ? everybody.filter((e) => e.id === filters.employeeId)
    : everybody;
  const shown = matching.slice(0, MAX_ROWS);
  const employeeIds = shown.map((e) => e.id);

  const [balances, approved] = await Promise.all([
    prisma.leaveBalance.findMany({
      where: { organizationId: ctx.organizationId, year, employeeId: { in: employeeIds } },
    }),
    // Approved leave is attributed to the year its first day falls in, which is
    // the rule `decideLeave` uses when it increments `used`. The two have to
    // agree or the comparison below would report a phantom mismatch every time
    // somebody takes leave over new year.
    prisma.leaveRequest.groupBy({
      by: ["employeeId", "leaveTypeId"],
      where: {
        organizationId: ctx.organizationId,
        employeeId: { in: employeeIds },
        status: "APPROVED",
        startDate: { gte: startOfYear(year), lte: endOfYear(year) },
      },
      _sum: { totalDays: true },
    }),
  ]);

  const stored = new Map(balances.map((b) => [cellKey(b.employeeId, b.leaveTypeId), b]));
  const approvedDays = new Map(
    approved.map((a) => [cellKey(a.employeeId, a.leaveTypeId), Number(a._sum.totalDays ?? 0)]),
  );

  const rows: BalanceRow[] = shown.map((employee) => ({
    employeeId: employee.id,
    employeeCode: employee.employeeCode,
    name: [employee.firstName, employee.lastName].filter(Boolean).join(" "),
    department: employee.department?.name ?? null,
    self: ctx.employeeId === employee.id,
    cells: shownTypes.map((rawType) => {
      /**
       * The type, with this person's designation applied.
       *
       * Resolved once, here, and everything downstream reads the resolved
       * object -- `accrualOf`, `impliedState` and the carry-forward all take a
       * type and would otherwise each need teaching about designations, and
       * would each be a place they could come to disagree.
       */
      const type = {
        ...rawType,
        annualAllocation: resolveAllocation({
          designation: designationAllocation(overrides, rawType.id, employee.designationId),
          type: rawType.annualAllocation,
        }),
      };
      const key = cellKey(employee.id, type.id);
      const row = stored.get(key);
      const accrues = type.accrualMode === "MONTHLY";
      const months = monthsWorkedIn(year, employee.joiningDate, today);
      const state = row
        ? {
            allocated: Number(row.allocated),
            // Read back through `accruedForRow` rather than taken literally.
            // Rows predating the year-end run — one created by an approval,
            // which leaves the column at zero — would otherwise report an
            // accrual type as having earned nothing all year.
            accrued: accruedForRow(Number(row.accrued), accrualOf(type, months)),
            used: Number(row.used),
            carriedForward: Number(row.carriedForward),
            encashed: Number(row.encashed),
          }
        : impliedState(type, months);

      return {
        leaveTypeId: type.id,
        ...state,
        available: availableDays(state, accrues),
        stored: row != null,
        approved: approvedDays.get(key) ?? 0,
      };
    }),
  }));

  return {
    year,
    thisYear,
    years: [thisYear - 2, thisYear - 1, thisYear, thisYear + 1],
    types: types.map(toTypeRow),
    rows,
    employees: everybody.map((e) => ({
      id: e.id,
      code: e.employeeCode,
      name: [e.firstName, e.lastName].filter(Boolean).join(" "),
    })),
    filters: {
      employeeId: filters.employeeId ?? null,
      leaveTypeId: filters.leaveTypeId ?? null,
    },
    truncated: matching.length > shown.length,
    total: matching.length,
  };
}

/* -------------------------------------------------------------------------- */
/*  Adjusting one balance                                                      */
/* -------------------------------------------------------------------------- */

export interface AdjustBalanceInput {
  employeeId: string;
  leaveTypeId: string;
  year: number;
  /** Days granted for the year. Omitted means "leave it alone". */
  allocated?: number;
  /** Days brought in from last year. Omitted means "leave it alone". */
  carriedForward?: number;
  /** Mandatory. It is the only record of why a balance stopped being the norm. */
  reason: string;
}

export interface AdjustBalanceResult {
  employeeId: string;
  leaveTypeId: string;
  year: number;
  before: LeaveBalanceState;
  after: LeaveBalanceState;
}

/**
 * Move one person's allocation or carried-forward days.
 *
 * `used`, `accrued` and `encashed` are not arguments and never will be. `used`
 * belongs to the approval path; `accrued` belongs to the accrual arithmetic;
 * `encashed` belongs to full-and-final settlement. Anything that needs to move
 * one of those has a service of its own, and typing over them here would only
 * make this screen and that one disagree.
 */
export async function adjustBalance(
  ctx: AuthContext,
  input: AdjustBalanceInput,
): Promise<AdjustBalanceResult> {
  requireOrg(ctx);
  requireWrite(ctx, "leave.balance.manage", "leave");

  // Nobody adjusts their own entitlement. An allocation is days off that a
  // full-and-final settlement encashes at the basis component's rate, so this
  // field is money with a longer fuse than a salary revision — and
  // `leave.balance.manage` can now be handed to anybody from the individual
  // permissions screen. The same rule the rest of the product already applies
  // to approving your own leave, clearing your own attendance, changing your
  // own permissions and setting your own salary.
  if (ctx.employeeId && ctx.employeeId === input.employeeId) {
    throw new ForbiddenError(
      "You cannot adjust your own leave balance. Somebody else with permission to manage balances has to make the change.",
    );
  }

  const reason = input.reason.trim();
  if (reason.length < 5) {
    throw new ValidationError(
      "Say why this balance is changing. It is the only explanation anybody reading the audit log will get.",
    );
  }

  if (input.allocated === undefined && input.carriedForward === undefined) {
    throw new ValidationError("Nothing to change — set an allocation or a carried-forward figure.");
  }

  const allocated = input.allocated === undefined ? undefined : assertDays(input.allocated, "allocation");
  const carriedForward =
    input.carriedForward === undefined
      ? undefined
      : assertDays(input.carriedForward, "carried-forward figure");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const thisYear = Number(today.slice(0, 4));
  if (input.year < thisYear - 3 || input.year > thisYear + 1) {
    throw new ValidationError(
      `Balances can be adjusted between ${thisYear - 3} and ${thisYear + 1}.`,
    );
  }

  const [employee, rawType, allocationRows] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: input.employeeId, organizationId: ctx.organizationId },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        joiningDate: true,
        designationId: true,
      },
    }),
    prisma.leaveType.findFirst({
      where: { id: input.leaveTypeId, organizationId: ctx.organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        accrualMode: true,
        annualAllocation: true,
        monthlyAccrual: true,
      },
    }),
    prisma.designationLeaveAllocation.findMany({
      where: { organizationId: ctx.organizationId, leaveTypeId: input.leaveTypeId },
      select: { leaveTypeId: true, designationId: true, annualAllocation: true },
    }),
  ]);
  // Not `assertSameTenant`, because the queries are already tenant-scoped: a row
  // belonging to another organisation simply does not come back, and 404 is the
  // answer either way.
  if (!employee) throw new NotFoundError("That employee");
  if (!rawType) throw new NotFoundError("That leave type");

  /**
   * The type with this person's designation applied, so the "before" figures
   * this screen shows — and the row it creates when there is none — match the
   * grid the administrator was looking at a moment ago.
   *
   * Reading the company-wide number here meant the dialog opened on a different
   * allocation from the cell that opened it, and creating a row from it wrote
   * the company figure into the personal layer, where it then outranked the
   * designation permanently.
   */
  const type = {
    ...rawType,
    annualAllocation: resolveAllocation({
      designation: designationAllocation(
        allocationOverrides(allocationRows),
        rawType.id,
        employee.designationId,
      ),
      type: rawType.annualAllocation,
    }),
  };

  const existing = await prisma.leaveBalance.findUnique({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId: employee.id,
        leaveTypeId: type.id,
        year: input.year,
      },
    },
  });
  // The composite key already went through the employee, which is tenant-checked
  // above — this is the belt to that pair of braces.
  if (existing) assertSameTenant(ctx, existing, "That leave balance");

  const accrues = type.accrualMode === "MONTHLY";
  const months = monthsWorkedIn(input.year, employee.joiningDate, today);
  const before: LeaveBalanceState = existing
    ? {
        allocated: Number(existing.allocated),
        accrued: accruedForRow(Number(existing.accrued), accrualOf(type, months)),
        used: Number(existing.used),
        carriedForward: Number(existing.carriedForward),
        encashed: Number(existing.encashed),
      }
    : impliedState(type, months);

  const after: LeaveBalanceState = {
    ...before,
    ...(allocated === undefined ? {} : { allocated }),
    ...(carriedForward === undefined ? {} : { carriedForward }),
  };

  // A balance is only nonsense when what has been granted no longer covers what
  // has already been taken. The check is one-sided on purpose: rows that are
  // *already* short — an accrual type whose `accrued` was never written, say —
  // must still be repairable, so only a change that makes the shortfall worse
  // is refused.
  const consumed = round2(after.used + after.encashed);
  const grantedBefore = round2((accrues ? before.accrued : before.allocated) + before.carriedForward);
  const grantedAfter = round2((accrues ? after.accrued : after.allocated) + after.carriedForward);
  if (grantedAfter < consumed && grantedAfter < grantedBefore) {
    throw new ConflictError(
      `${employee.firstName} has already taken ${consumed} day(s) of ${type.name} in ${input.year}, and ${grantedAfter} day(s) would not cover that. Leave taken is never edited here — reject or cancel the leave itself if it is wrong.`,
    );
  }

  const row = await prisma.leaveBalance.upsert({
    where: {
      employeeId_leaveTypeId_year: {
        employeeId: employee.id,
        leaveTypeId: type.id,
        year: input.year,
      },
    },
    // `used` and `encashed` are not named here at all — they take the column
    // default. There cannot be either without a row, because an approval is
    // what creates one, and a service that never writes the word cannot be one
    // refactor away from writing it.
    //
    // Creating the row freezes `accrued`, because nothing in the product ever
    // recomputes it: `getLeaveBalances` works accrual out on the fly *only*
    // while no row exists, and `decideLeave` already creates rows with it left
    // at zero. Writing what has genuinely accrued so far is the least wrong
    // figure available — a zero here would read as "no leave earned this year"
    // for every monthly-accrual type.
    create: {
      organizationId: ctx.organizationId,
      employeeId: employee.id,
      leaveTypeId: type.id,
      year: input.year,
      allocated: after.allocated,
      accrued: after.accrued,
      carriedForward: after.carriedForward,
    },
    // Only the two fields this screen owns. Spelling out `used` here, even as
    // an unchanged value, would be one refactor away from writing it.
    update: {
      ...(allocated === undefined ? {} : { allocated }),
      ...(carriedForward === undefined ? {} : { carriedForward }),
    },
  });

  await writeAudit(ctx, {
    action: "leave.balance_adjusted",
    entityType: "LeaveBalance",
    entityId: row.id,
    before,
    after,
    metadata: {
      reason,
      year: input.year,
      employeeCode: employee.employeeCode,
      leaveType: type.code,
      createdRow: existing == null,
    },
  });

  return { employeeId: employee.id, leaveTypeId: type.id, year: input.year, before, after };
}

/* -------------------------------------------------------------------------- */
/*  The year-end run                                                           */
/* -------------------------------------------------------------------------- */

export interface CarryForwardType {
  id: string;
  code: string;
  name: string;
  accrues: boolean;
  carryForward: boolean;
  maxCarryForward: number;
  annualAllocation: number;
}

export interface CarryForwardPerson {
  id: string;
  code: string;
  name: string;
}

export type CarryForwardAction = "CREATE" | "UPDATE" | "UNCHANGED";

export interface CarryForwardLine {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  leaveTypeId: string;
  typeCode: string;
  typeName: string;
  /** Days left at the end of the old year, before the type's cap. */
  unused: number;
  /** What actually carries. */
  carried: number;
  /** Days the cap drops. Shown because somebody always asks where they went. */
  lapsed: number;
  /** What the new year's row says now — non-zero when the run has been done before. */
  current: number;
  action: CarryForwardAction;
}

export interface CarryForwardPlan {
  lines: CarryForwardLine[];
  /** People with at least one line that would move. */
  employees: number;
  /** Days that would be written into the new year across those lines. */
  days: number;
  /** Days dropped by the caps, across every line. */
  lapsed: number;
  created: number;
  updated: number;
  unchanged: number;
}

export interface CarryForwardPlanInput {
  types: CarryForwardType[];
  people: CarryForwardPerson[];
  /** Closing position of the old year, keyed `employeeId:leaveTypeId`. */
  closing: ReadonlyMap<string, LeaveBalanceState>;
  /**
   * What the new year already says, keyed the same way. A key being present
   * means the row exists — that is what separates a create from an update, and
   * an update from doing nothing at all.
   */
  opening: ReadonlyMap<string, number>;
}

/**
 * What the run would do, as data.
 *
 * Pure, and exported, because idempotency is a property of *this* function and
 * a property is worth a test: feed the plan's own result back in as `opening`
 * and every line has to come out `UNCHANGED`. A second run cannot double a
 * balance because carry-forward is computed from the year that ended and
 * **set**, never added to what is already there.
 */
export function planCarryForward(input: CarryForwardPlanInput): CarryForwardPlan {
  const lines: CarryForwardLine[] = [];
  const movers = new Set<string>();
  let days = 0;
  let lapsed = 0;
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const person of input.people) {
    for (const type of input.types) {
      if (!type.carryForward) continue;

      const key = cellKey(person.id, type.id);
      const state = input.closing.get(key);
      if (!state) continue;

      const carried = carryForwardAmount(state, type.accrues, type.carryForward, type.maxCarryForward);
      const unused = round2(Math.max(0, availableDays(state, type.accrues)));
      const dropped = round2(Math.max(0, unused - carried));
      const current = input.opening.get(key) ?? 0;
      const exists = input.opening.has(key);

      const action: CarryForwardAction =
        current === carried ? "UNCHANGED" : exists ? "UPDATE" : "CREATE";

      // Nothing to carry and nothing on record: not a line, not a row. The run
      // does not create empty balances for people who took all their leave.
      if (action === "UNCHANGED" && carried === 0) continue;

      if (action === "CREATE") created++;
      else if (action === "UPDATE") updated++;
      else unchanged++;

      if (action !== "UNCHANGED") {
        movers.add(person.id);
        days = round2(days + carried);
      }
      lapsed = round2(lapsed + dropped);

      lines.push({
        employeeId: person.id,
        employeeCode: person.code,
        employeeName: person.name,
        leaveTypeId: type.id,
        typeCode: type.code,
        typeName: type.name,
        unused,
        carried,
        lapsed: dropped,
        current,
        action,
      });
    }
  }

  return { lines, employees: movers.size, days, lapsed, created, updated, unchanged };
}

export interface CarryForwardInput {
  fromYear: number;
  toYear: number;
  /** False — the default — computes the plan and writes nothing. */
  commit?: boolean;
}

export interface CarryForwardSummary extends CarryForwardPlan {
  fromYear: number;
  toYear: number;
  committed: boolean;
  /** Types that carry nothing, and why, so their absence is not a mystery. */
  skipped: { code: string; name: string; reason: string }[];
  /** Employees the run looked at. */
  considered: number;
}

/**
 * Close one leave year into the next.
 *
 * Preview and commit are the same call with the same arithmetic — `commit`
 * only decides whether the rows are written — so what the screen showed is what
 * the run does, rather than a description of it assembled separately.
 */
export async function runCarryForward(
  ctx: AuthContext,
  input: CarryForwardInput,
): Promise<CarryForwardSummary> {
  requireOrg(ctx);
  const commit = input.commit ?? false;
  if (commit) requireWrite(ctx, "leave.balance.manage", "leave");
  else requirePermission(ctx, "leave.balance.manage");
  requireModule(ctx, "leave");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const thisYear = Number(today.slice(0, 4));

  if (input.toYear !== input.fromYear + 1) {
    throw new ValidationError(
      "Carry-forward runs from one year into the one straight after it. Anything else would skip a year's leave.",
    );
  }
  if (input.fromYear > thisYear) {
    throw new ValidationError(`${input.fromYear} has not happened yet.`);
  }
  if (input.fromYear < thisYear - 3) {
    throw new ValidationError(`Carry-forward only goes back to ${thisYear - 3}.`);
  }

  const [types, people, allocationRows] = await Promise.all([
    prisma.leaveType.findMany({
      where: { organizationId: ctx.organizationId, active: true },
      orderBy: { code: "asc" },
      select: {
        id: true,
        code: true,
        name: true,
        accrualMode: true,
        annualAllocation: true,
        monthlyAccrual: true,
        carryForward: true,
        maxCarryForward: true,
      },
    }),
    prisma.employee.findMany({
      where: {
        organizationId: ctx.organizationId,
        active: true,
        joiningDate: { lte: endOfYear(input.fromYear) },
      },
      orderBy: { employeeCode: "asc" },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        joiningDate: true,
        designationId: true,
      },
    }),
    prisma.designationLeaveAllocation.findMany({
      where: { organizationId: ctx.organizationId },
      select: { leaveTypeId: true, designationId: true, annualAllocation: true },
    }),
  ]);

  const overrides = allocationOverrides(allocationRows);
  const designationOf = new Map(people.map((p) => [p.id, p.designationId]));
  /**
   * The type as it applies to one person.
   *
   * The year-end run is where an unearned allocation becomes a permanent one:
   * whatever it decides is unused gets written into next year's row. Working
   * from the company-wide figure meant a trainee whose designation grants no
   * earned leave still carried the company's fifteen days into January, and a
   * manager granted more than the company figure carried less than they had.
   */
  const typeFor = (type: TypeShape & { id: string }, employeeId: string): TypeShape => ({
    ...type,
    annualAllocation: resolveAllocation({
      designation: designationAllocation(overrides, type.id, designationOf.get(employeeId)),
      type: type.annualAllocation,
    }),
  });

  const carrying = types.filter((t) => t.carryForward && Number(t.maxCarryForward) > 0);
  const employeeIds = people.map((p) => p.id);

  const [closingRows, openingRows] = await Promise.all([
    prisma.leaveBalance.findMany({
      where: {
        organizationId: ctx.organizationId,
        year: input.fromYear,
        employeeId: { in: employeeIds },
        leaveTypeId: { in: carrying.map((t) => t.id) },
      },
    }),
    prisma.leaveBalance.findMany({
      where: {
        organizationId: ctx.organizationId,
        year: input.toYear,
        employeeId: { in: employeeIds },
        leaveTypeId: { in: carrying.map((t) => t.id) },
      },
      select: { employeeId: true, leaveTypeId: true, carriedForward: true },
    }),
  ]);

  const carryingById = new Map(carrying.map((t) => [t.id, t]));
  const monthsOf = new Map(
    people.map((p) => [p.id, monthsWorkedIn(input.fromYear, p.joiningDate, today)]),
  );

  const storedClosing = new Map(
    closingRows.map((b) => {
      const type = carryingById.get(b.leaveTypeId);
      return [
        cellKey(b.employeeId, b.leaveTypeId),
        {
          allocated: Number(b.allocated),
          // Derived for accrual types, so somebody who took a single day last
          // year — and therefore has a row, holding a zero — carries forward
          // the same as the colleague who took none and has no row at all.
          accrued: type
            ? accruedForRow(
                Number(b.accrued),
                accrualOf(typeFor(type, b.employeeId), monthsOf.get(b.employeeId) ?? 0),
              )
            : Number(b.accrued),
          used: Number(b.used),
          carriedForward: Number(b.carriedForward),
          encashed: Number(b.encashed),
        },
      ] as const;
    }),
  );

  // Somebody who took no leave at all has no `LeaveBalance` row — rows are only
  // created on approval. Reading only stored rows would therefore carry nothing
  // for the person who used nothing and everything for the person who used a
  // day, which is precisely backwards. The implied state is the same one the
  // employee's own leave screen shows them.
  const closing = new Map<string, LeaveBalanceState>();
  for (const person of people) {
    const months = monthsOf.get(person.id) ?? 0;
    for (const type of carrying) {
      const key = cellKey(person.id, type.id);
      closing.set(key, storedClosing.get(key) ?? impliedState(typeFor(type, person.id), months));
    }
  }

  const opening = new Map(
    openingRows.map((b) => [cellKey(b.employeeId, b.leaveTypeId), Number(b.carriedForward)]),
  );

  const plan = planCarryForward({
    types: carrying.map(toCarryType),
    people: people.map((p) => ({
      id: p.id,
      code: p.employeeCode,
      name: [p.firstName, p.lastName].filter(Boolean).join(" "),
    })),
    closing,
    opening,
  });

  const moving = plan.lines.filter((line) => line.action !== "UNCHANGED");

  if (commit && moving.length > 0) {
    const typeById = new Map(carrying.map((t) => [t.id, t]));
    const personById = new Map(people.map((p) => [p.id, p]));

    // Chunked rather than one transaction: a year-end run over a large
    // organisation is thousands of upserts and an interactive transaction that
    // size is a lock held for as long as it takes. Chunking is only safe
    // because the run is idempotent — a chunk that fails leaves the rows it did
    // write at their final value, and running again finishes the job without
    // touching them twice.
    for (let i = 0; i < moving.length; i += WRITE_CHUNK) {
      const chunk = moving.slice(i, i + WRITE_CHUNK);
      await prisma.$transaction(
        chunk.map((line) => {
          const type = typeById.get(line.leaveTypeId);
          const person = personById.get(line.employeeId);
          // Creating the row is what makes `accrued` matter. Every reader —
          // `getLeaveBalances`, the grid above, the settlement — takes a stored
          // row as authoritative and only falls back to the accrual arithmetic
          // when no row exists, and nothing in the product recomputes the
          // column afterwards. So leaving it at the column default would not be
          // "no figure": on a MONTHLY type it is the figure zero, and the
          // shipped Earned Leave both accrues monthly and carries forward.
          // Writing what the reader would itself have implied at this moment
          // keeps the row saying what its absence said, which is the same thing
          // `adjustBalance` does when it creates one.
          //
          // Months are counted as at today, and a year that has not started yet
          // counts none: running the close early, in December, must not hand
          // everybody a full year of accrual to spend on the 1st of January.
          const implied = impliedState(
            type
              ? typeFor(type, line.employeeId)
              : { accrualMode: "NONE", annualAllocation: 0, monthlyAccrual: 0 },
            input.toYear > thisYear
              ? 0
              : monthsWorkedIn(input.toYear, person?.joiningDate ?? null, today),
          );

          return prisma.leaveBalance.upsert({
            where: {
              employeeId_leaveTypeId_year: {
                employeeId: line.employeeId,
                leaveTypeId: line.leaveTypeId,
                year: input.toYear,
              },
            },
            create: {
              organizationId: ctx.organizationId,
              employeeId: line.employeeId,
              leaveTypeId: line.leaveTypeId,
              year: input.toYear,
              allocated: implied.allocated,
              accrued: implied.accrued,
              carriedForward: line.carried,
            },
            // `set`, not `increment`. This single word is the difference
            // between a re-run being harmless and it doubling everybody's
            // balance. `allocated` is left alone on an existing row: it may
            // already have been adjusted by hand for this year.
            update: { carriedForward: line.carried },
          });
        }),
      );
    }

    /**
     * The prior value of every line, so the run can be taken back.
     *
     * `runCarryForward` writes with `set` rather than `increment` -- which is
     * what makes a re-run harmless, and an undo impossible, because the old
     * figure is gone the moment the new one lands. Writing it down here is the
     * whole of the undo; nothing else about the run changes.
     *
     * A CREATE line records `before: null`, because the balance row did not
     * exist. Undoing one sets its carried days to zero rather than deleting the
     * row: leave approved in the new year since would have put a `used` figure
     * on it, and destroying that to reverse a carry-forward would be trading
     * one wrong number for a lost one.
     */
    await prisma.leaveCarryForwardRun.create({
      data: {
        organizationId: ctx.organizationId,
        fromYear: input.fromYear,
        toYear: input.toYear,
        days: plan.days,
        employees: plan.employees,
        ranById: ctx.userId,
        lines: moving.map((line) => ({
          employeeId: line.employeeId,
          leaveTypeId: line.leaveTypeId,
          before: line.action === "CREATE" ? null : line.current,
          after: line.carried,
        })),
      },
    });

    await writeAudit(ctx, {
      action: "leave.carry_forward_run",
      entityType: "LeaveBalance",
      after: {
        fromYear: input.fromYear,
        toYear: input.toYear,
        employees: plan.employees,
        days: plan.days,
        created: plan.created,
        updated: plan.updated,
      },
      metadata: {
        lapsed: plan.lapsed,
        unchanged: plan.unchanged,
        types: carrying.map((t) => t.code),
      },
    });
  }

  return {
    ...plan,
    fromYear: input.fromYear,
    toYear: input.toYear,
    committed: commit,
    considered: people.length,
    skipped: types
      .filter((t) => !carrying.some((c) => c.id === t.id))
      .map((t) => ({
        code: t.code,
        name: t.name,
        reason: t.carryForward
          ? "Carry-forward is on but the limit is zero days."
          : "This type does not carry forward.",
      })),
  };
}

/* -------------------------------------------------------------------------- */
/*  Undo and redo                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How many past runs stay reversible.
 *
 * Three, because the reason to undo one is almost always "we ran it on the
 * wrong year" or "we ran it twice" and both are noticed within a run or two.
 * Older runs stay listed and are shown as closed: a balance three closes old
 * has been spent against, and quietly rewriting it would be worse than saying
 * no.
 */
export const REVERSIBLE_RUNS = 3;

interface CarryLine {
  employeeId: string;
  leaveTypeId: string;
  before: number | null;
  after: number;
}

export interface CarryForwardRunRow {
  id: string;
  fromYear: number;
  toYear: number;
  days: number;
  employees: number;
  ranAt: string;
  ranBy: string | null;
  undoneAt: string | null;
  /** Whether this run is recent enough to be taken back or put back. */
  reversible: boolean;
}

function readLines(value: unknown): CarryLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.employeeId !== "string" || typeof row.leaveTypeId !== "string") return [];
    if (typeof row.after !== "number") return [];
    return [
      {
        employeeId: row.employeeId,
        leaveTypeId: row.leaveTypeId,
        before: typeof row.before === "number" ? row.before : null,
        after: row.after,
      },
    ];
  });
}

export async function listCarryForwardRuns(ctx: AuthContext): Promise<CarryForwardRunRow[]> {
  requireOrg(ctx);
  requirePermission(ctx, "leave.balance.manage");

  const rows = await prisma.leaveCarryForwardRun.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { ranAt: "desc" },
    take: 20,
    select: {
      id: true,
      fromYear: true,
      toYear: true,
      days: true,
      employees: true,
      ranAt: true,
      ranById: true,
      undoneAt: true,
    },
  });

  const ids = [...new Set(rows.map((r) => r.ranById).filter((v): v is string => Boolean(v)))];
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, organizationId: ctx.organizationId },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.name]));

  return rows.map((r, index) => ({
    id: r.id,
    fromYear: r.fromYear,
    toYear: r.toYear,
    days: Number(r.days),
    employees: r.employees,
    ranAt: r.ranAt.toISOString(),
    ranBy: r.ranById ? (nameById.get(r.ranById) ?? null) : null,
    undoneAt: r.undoneAt?.toISOString() ?? null,
    reversible: index < REVERSIBLE_RUNS,
  }));
}

/**
 * Take a carry-forward run back, or put it back again.
 *
 * The refusal in the middle is the point. If a balance this run wrote has been
 * changed since -- by a correction, or by a later run -- then reversing this
 * one would silently overwrite that change with a figure from before it
 * happened. So it stops and names the people, and whoever is holding the screen
 * decides. A carry-forward that quietly undoes somebody's correction is worse
 * than one that will not undo at all.
 */
async function applyReversal(
  ctx: AuthContext,
  runId: string,
  direction: "UNDO" | "REDO",
): Promise<{ changed: number }> {
  requireOrg(ctx);
  requireWrite(ctx, "leave.balance.manage", "leave");

  const recent = await prisma.leaveCarryForwardRun.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { ranAt: "desc" },
    take: REVERSIBLE_RUNS,
    select: { id: true },
  });
  if (!recent.some((r) => r.id === runId)) {
    throw new ValidationError(
      `Only the last ${REVERSIBLE_RUNS} carry-forward runs can be undone. Correct the balances by hand instead.`,
    );
  }

  const run = await prisma.leaveCarryForwardRun.findFirst({
    where: { id: runId, organizationId: ctx.organizationId },
  });
  if (!run) throw new NotFoundError("That carry-forward run");

  if (direction === "UNDO" && run.undoneAt) {
    throw new ConflictError("That run has already been undone.");
  }
  if (direction === "REDO" && !run.undoneAt) {
    throw new ConflictError("That run has not been undone, so there is nothing to put back.");
  }

  const lines = readLines(run.lines);
  if (lines.length === 0) {
    // Nothing was written, so nothing is reversed -- but the flag still moves,
    // so the button stops offering an action that would do nothing.
    await prisma.leaveCarryForwardRun.update({
      where: { id: runId },
      data:
        direction === "UNDO"
          ? { undoneAt: new Date(), undoneById: ctx.userId }
          : { undoneAt: null, undoneById: null },
    });
    return { changed: 0 };
  }

  // What the balances say now, against what this run left them at.
  const existing = await prisma.leaveBalance.findMany({
    where: {
      organizationId: ctx.organizationId,
      year: run.toYear,
      employeeId: { in: [...new Set(lines.map((l) => l.employeeId))] },
    },
    select: { employeeId: true, leaveTypeId: true, carriedForward: true },
  });
  const nowBy = new Map(
    existing.map((row) => [cellKey(row.employeeId, row.leaveTypeId), Number(row.carriedForward)]),
  );

  const expected = direction === "UNDO" ? "after" : "before";
  const moved = lines.filter((line) => {
    const current = nowBy.get(cellKey(line.employeeId, line.leaveTypeId)) ?? 0;
    const wanted = expected === "after" ? line.after : (line.before ?? 0);
    return round2(current) !== round2(wanted);
  });

  if (moved.length > 0) {
    const names = await prisma.employee.findMany({
      where: {
        id: { in: [...new Set(moved.map((l) => l.employeeId))].slice(0, 5) },
        organizationId: ctx.organizationId,
      },
      select: { firstName: true, lastName: true },
    });
    const listed = names
      .map((e) => [e.firstName, e.lastName].filter(Boolean).join(" "))
      .join(", ");
    throw new ConflictError(
      `${moved.length} balance(s) have changed since this run, so reversing it would overwrite those changes: ${listed}${
        moved.length > names.length ? " and others" : ""
      }. Correct them by hand instead.`,
    );
  }

  for (let i = 0; i < lines.length; i += WRITE_CHUNK) {
    const chunk = lines.slice(i, i + WRITE_CHUNK);
    await prisma.$transaction(
      chunk.map((line) =>
        prisma.leaveBalance.updateMany({
          where: {
            organizationId: ctx.organizationId!,
            employeeId: line.employeeId,
            leaveTypeId: line.leaveTypeId,
            year: run.toYear,
          },
          // `before: null` means the row did not exist before the run. Zero
          // rather than a delete: see the note where the lines are recorded.
          data: { carriedForward: direction === "UNDO" ? (line.before ?? 0) : line.after },
        }),
      ),
    );
  }

  await prisma.leaveCarryForwardRun.update({
    where: { id: runId },
    data:
      direction === "UNDO"
        ? { undoneAt: new Date(), undoneById: ctx.userId }
        : { undoneAt: null, undoneById: null },
  });

  await writeAudit(ctx, {
    action: direction === "UNDO" ? "leave.carry_forward_undone" : "leave.carry_forward_redone",
    entityType: "LeaveBalance",
    entityId: runId,
    after: { fromYear: run.fromYear, toYear: run.toYear, lines: lines.length },
  });

  return { changed: lines.length };
}

export function undoCarryForward(ctx: AuthContext, runId: string) {
  return applyReversal(ctx, runId, "UNDO");
}

export function redoCarryForward(ctx: AuthContext, runId: string) {
  return applyReversal(ctx, runId, "REDO");
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function cellKey(employeeId: string, leaveTypeId: string): string {
  return `${employeeId}:${leaveTypeId}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function startOfYear(year: number): Date {
  return new Date(`${year}-01-01T00:00:00.000Z`);
}

function endOfYear(year: number): Date {
  return new Date(`${year}-12-31T00:00:00.000Z`);
}

/** `@db.Date` comes back as UTC midnight, so the first ten characters are the day. */
function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

function assertDays(value: number, what: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ValidationError(`The ${what} cannot be negative.`);
  }
  if (value > MAX_DAYS) {
    throw new ValidationError(`${value} days is not a leave ${what} anybody meant to type.`);
  }
  if (Math.round(value / DAY_STEP) * DAY_STEP !== value) {
    throw new ValidationError("Leave is counted in half days, so use figures like 12 or 12.5.");
  }
  return round2(value);
}

/**
 * Months of `year` somebody was employed for.
 *
 * Mirrors `getLeaveBalances` on purpose: an implied figure here that disagreed
 * with the one on the employee's own leave screen would send an administrator
 * hunting a bug that is only a difference of arithmetic. The one addition is
 * the later-joiner case, which the read path never asks about because it only
 * ever asks about the current year.
 */
function monthsWorkedIn(year: number, joiningDate: Date | null, today: DateOnly): number {
  const joined = joiningDate ? toDateOnly(joiningDate) : `${year}-01-01`;
  const joinedYear = Number(joined.slice(0, 4));
  const thisYear = Number(today.slice(0, 4));
  // Nobody has worked a month of a year that has not started, and nobody worked
  // a year they joined after. The read path asks neither question because it
  // only ever asks about the current year; this grid offers next year in its
  // picker, where "twelve months accrued" would be a straight lie.
  if (joinedYear > year || year > thisYear) return 0;

  const startMonth = joinedYear === year ? Number(joined.slice(5, 7)) : 1;
  const currentMonth = thisYear === year ? Number(today.slice(5, 7)) : 12;
  return Math.max(0, currentMonth - startMonth + 1);
}

/** The accrual question, in the shape the domain answers it. */
function accrualOf(type: TypeShape, monthsWorked: number) {
  return {
    annualAllocation: Number(type.annualAllocation),
    monthlyAccrual: Number(type.monthlyAccrual),
    accrualMode: type.accrualMode as "ANNUAL" | "MONTHLY" | "NONE",
    monthsWorked,
  };
}

interface TypeShape {
  accrualMode: string;
  annualAllocation: unknown;
  monthlyAccrual: unknown;
}

/** What a balance would be if nobody had ever written a row for it. */
function impliedState(type: TypeShape, monthsWorked: number): LeaveBalanceState {
  return {
    allocated: Number(type.annualAllocation),
    accrued: accruedSoFar({
      annualAllocation: Number(type.annualAllocation),
      monthlyAccrual: Number(type.monthlyAccrual),
      accrualMode: type.accrualMode as "ANNUAL" | "MONTHLY" | "NONE",
      monthsWorked,
    }),
    used: 0,
    carriedForward: 0,
    encashed: 0,
  };
}

function toTypeRow(type: {
  id: string;
  code: string;
  name: string;
  color: string;
  paid: boolean;
  accrualMode: string;
  annualAllocation: unknown;
  carryForward: boolean;
  maxCarryForward: unknown;
}): BalanceTypeRow {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    color: type.color,
    paid: type.paid,
    accrues: type.accrualMode === "MONTHLY",
    annualAllocation: Number(type.annualAllocation),
    carryForward: type.carryForward,
    maxCarryForward: Number(type.maxCarryForward),
  };
}

function toCarryType(type: {
  id: string;
  code: string;
  name: string;
  accrualMode: string;
  annualAllocation: unknown;
  carryForward: boolean;
  maxCarryForward: unknown;
}): CarryForwardType {
  return {
    id: type.id,
    code: type.code,
    name: type.name,
    accrues: type.accrualMode === "MONTHLY",
    carryForward: type.carryForward,
    maxCarryForward: Number(type.maxCarryForward),
    annualAllocation: Number(type.annualAllocation),
  };
}
