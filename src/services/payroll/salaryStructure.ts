import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import {
  assertSameTenant,
  hasPermission,
  requireAnyPermission,
  requireModule,
  requireOrg,
  requirePermission,
  requireWrite,
  visibleEmployeeIds,
} from "@/lib/auth/guard";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { getPayrollPolicy, savePolicyVersion } from "@/services/policy";
import {
  type DateOnly,
  MONTH_NAMES,
  addDays,
  isDateOnly,
  parts,
  todayInZone,
} from "@/domain/date";
import {
  type ResolvedStructure,
  type StructureIssue,
  resolveSalaryStructure,
  salaryComponentSchema,
  validateSalaryStructure,
} from "@/domain/payroll/policy";
import type {
  ComponentCalc,
  ComponentKind,
  PercentBase,
  SalaryComponent,
} from "@/domain/payroll/types";

/**
 * The salary structure: the components pay is built from, and one person's
 * revisions of it.
 *
 * Two permissions were declared, granted to Admins, and gated nothing, because
 * neither screen existed: `salary.structure.manage` and `employee.salary.manage`.
 * The consequences were quiet ones. `validateSalaryStructure` was called from no
 * write path at all, so a structure whose percentages total 87 % — or one whose
 * components refer to each other in a circle — could sit in the database and be
 * discovered on payday. And a `SalaryProfile` could only ever be created by the
 * seed script, so a raise had nowhere to be recorded.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * **The stored shape.** `SalaryProfile.structure` is a *bare array of earnings* —
 * `[{ code, name, amountPaise, formula }]` — not `{ components: [...] }`. That is
 * what `prisma/seed.ts` writes and what `services/exit/fnf.ts` reads to find the
 * gratuity basis. Writing the wrapped shape instead would make a full and final
 * settlement compute zero, which looks exactly like a valid answer.
 *
 * **Revisions are added, never edited.** Payroll for March must keep reading what
 * it read in March. So a new salary closes the previous revision by dating its
 * `effectiveTo` to the day before, and a revision that would land in a month
 * already locked — money that has been paid — is refused outright.
 */

// ------------------------------------------------------------------ components

export interface ComponentRow extends SalaryComponent {
  id: string;
  active: boolean;
  /**
   * The stored `calc` did not parse. The row is still listed so somebody can
   * fix it, but its `calc` here is a placeholder, not what is in the database.
   */
  malformed: boolean;
}

export interface SalaryStructureSnapshot {
  components: ComponentRow[];
  /** Whether percentages are of the whole CTC or of what is left after fixed amounts. */
  percentBase: PercentBase;
  /** What `validateSalaryStructure` says about the active set as it stands. */
  issues: StructureIssue[];
  /** The organisation has never published payroll rules; the shipped defaults are in force. */
  policyIsDefault: boolean;
  /**
   * Codes where this catalogue and the payroll policy disagree.
   *
   * Payroll pays from the policy, so a divergence means the list below is not
   * what a payslip would show. Saving any component republishes the whole set
   * and clears it.
   */
  notInPayroll: string[];
  onlyInPayroll: string[];
}

export interface SalaryComponentInput {
  id?: string;
  code: string;
  name: string;
  kind: ComponentKind;
  calc: ComponentCalc;
  prorated?: boolean;
  taxable?: boolean;
  showOnSlip?: boolean;
  sortOrder?: number;
  active?: boolean;
}

const PLACEHOLDER_CALC: ComponentCalc = { type: "FIXED", amountPaise: 0 };

/**
 * Order-independent equality.
 *
 * Written field by field rather than by stringifying the objects: the two sets
 * come from different places — one from a zod parse, one from stored JSON — and
 * `JSON.stringify` would call them different because their keys happen to be in
 * a different order.
 */
function sameComponentSet(a: readonly SalaryComponent[], b: readonly SalaryComponent[]): boolean {
  const calcKey = (calc: ComponentCalc): string => {
    switch (calc.type) {
      case "PERCENT_OF_CTC":
        return `PERCENT_OF_CTC:${calc.percent}`;
      case "PERCENT_OF_COMPONENT":
        return `PERCENT_OF_COMPONENT:${calc.of}:${calc.percent}`;
      case "FIXED":
        return `FIXED:${calc.amountPaise}`;
      case "BALANCE":
        return "BALANCE";
    }
  };
  const key = (list: readonly SalaryComponent[]) =>
    list
      .map(
        (c) =>
          `${c.code}|${c.name}|${c.kind}|${calcKey(c.calc)}|${c.prorated}|${c.taxable}|${c.showOnSlip}|${c.sortOrder}`,
      )
      .sort()
      .join("\n");
  return key(a) === key(b);
}

/**
 * A database row as the domain sees it.
 *
 * `calc` is `Json`, so it is parsed rather than cast. A row that will not parse
 * is reported as malformed instead of being quietly given a zero calculation —
 * a component silently worth nothing is the failure mode this whole file exists
 * to avoid.
 */
function toRow(row: {
  id: string;
  code: string;
  name: string;
  kind: ComponentKind;
  calc: unknown;
  prorated: boolean;
  taxable: boolean;
  showOnSlip: boolean;
  sortOrder: number;
  active: boolean;
}): ComponentRow {
  const parsed = salaryComponentSchema.safeParse({
    code: row.code,
    name: row.name,
    kind: row.kind,
    calc: row.calc,
    prorated: row.prorated,
    taxable: row.taxable,
    showOnSlip: row.showOnSlip,
    sortOrder: row.sortOrder,
  });

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    calc: parsed.success ? parsed.data.calc : PLACEHOLDER_CALC,
    prorated: row.prorated,
    taxable: row.taxable,
    showOnSlip: row.showOnSlip,
    sortOrder: row.sortOrder,
    active: row.active,
    malformed: !parsed.success,
  };
}

/** Drops the row-only fields, leaving what the domain functions take. */
function toComponent(row: ComponentRow): SalaryComponent {
  return {
    code: row.code,
    name: row.name,
    kind: row.kind,
    calc: row.calc,
    prorated: row.prorated,
    taxable: row.taxable,
    showOnSlip: row.showOnSlip,
    sortOrder: row.sortOrder,
  };
}

export async function getSalaryComponents(ctx: AuthContext): Promise<SalaryStructureSnapshot> {
  requireOrg(ctx);
  requirePermission(ctx, "salary.structure.manage");
  // The save refuses with payroll switched off, so the screen in front of it
  // has to as well — otherwise this reads as a live catalogue for an
  // organisation that does not run payroll at all.
  requireModule(ctx, "payroll");

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const [rows, current] = await Promise.all([
    prisma.salaryComponent.findMany({
      where: { organizationId: ctx.organizationId },
      orderBy: [{ active: "desc" }, { sortOrder: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        kind: true,
        calc: true,
        prorated: true,
        taxable: true,
        showOnSlip: true,
        sortOrder: true,
        active: true,
      },
    }),
    getPayrollPolicy(ctx, today),
  ]);

  const components = rows.map(toRow);
  const active = components.filter((c) => c.active);
  const inPolicy = new Set(current.policy.components.map((c) => c.code));
  const inCatalogue = new Set(active.map((c) => c.code));

  return {
    components,
    percentBase: current.policy.percentBase,
    issues: validateSalaryStructure(active.map(toComponent), current.policy.percentBase),
    policyIsDefault: current.isDefault,
    notInPayroll: active.filter((c) => !inPolicy.has(c.code)).map((c) => c.code),
    onlyInPayroll: current.policy.components
      .filter((c) => !inCatalogue.has(c.code))
      .map((c) => c.code),
  };
}

/**
 * Creates or updates one component, then republishes the payroll policy.
 *
 * The republish is the point. The engine reads `policy.components`, never this
 * table — `services/ai/payrollRules.ts` syncs the table *from* the policy on
 * activation and says so — so a component saved only here would show on this
 * screen and never reach a payslip. Publishing needs `payroll.rules.manage`,
 * which every role holding `salary.structure.manage` also holds by default; a
 * per-user grant can separate them, and then this refuses with a reason rather
 * than saving something that will never be paid.
 *
 * Nothing is ever deleted. A code is stamped into every `SalaryProfile.structure`
 * and every `PayrollItem.earnings` that used it, so an unwanted component is
 * switched off: it leaves the structure from the next policy version onwards and
 * stays legible in everything that already refers to it. Same reasoning as
 * departments in `org/structure.ts`.
 */
export async function saveSalaryComponent(
  ctx: AuthContext,
  input: SalaryComponentInput,
): Promise<SalaryStructureSnapshot> {
  requireOrg(ctx);
  requireWrite(ctx, "salary.structure.manage", "payroll");

  if (!hasPermission(ctx, "payroll.rules.manage")) {
    throw new ForbiddenError(
      "Changing the component set changes how everybody is paid, so it also needs permission to manage payroll rules.",
    );
  }

  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the component a name.");

  const candidate = salaryComponentSchema.safeParse({
    code,
    name,
    kind: input.kind,
    calc: input.calc,
    prorated: input.prorated ?? true,
    taxable: input.taxable ?? true,
    showOnSlip: input.showOnSlip ?? true,
    sortOrder: input.sortOrder ?? 0,
  });
  if (!candidate.success) {
    throw new ValidationError("That component is not valid.", {
      issues: candidate.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const component = candidate.data;
  const active = input.active ?? true;

  const rows = (
    await prisma.salaryComponent.findMany({
      where: { organizationId: ctx.organizationId },
      select: {
        id: true,
        code: true,
        name: true,
        kind: true,
        calc: true,
        prorated: true,
        taxable: true,
        showOnSlip: true,
        sortOrder: true,
        active: true,
      },
    })
  ).map(toRow);

  let before: ComponentRow | null = null;

  if (input.id) {
    const row = await prisma.salaryComponent.findUnique({
      where: { id: input.id },
      select: { id: true, organizationId: true, code: true },
    });
    assertSameTenant(ctx, row, "That salary component");

    // The code is the identifier every stored structure, payslip line and
    // settlement refers to. Renaming it would orphan all of them silently.
    if (row!.code !== code) {
      throw new ValidationError(
        `A component's code is stamped on every salary revision and payslip that used it, so ${row!.code} cannot be renamed. Switch it off and add a new one instead.`,
      );
    }
    before = rows.find((r) => r.id === input.id) ?? null;

    // `getSalaryComponents` hands out `PLACEHOLDER_CALC` for a row whose stored
    // `calc` will not parse, so a client that echoes a row back — switching it
    // on, say — would publish that component at zero rupees without anybody
    // having typed a number. The one thing this file exists to prevent. A real
    // repair sends a real calculation, so only the placeholder is refused.
    if (
      before?.malformed &&
      component.calc.type === "FIXED" &&
      component.calc.amountPaise === 0
    ) {
      throw new ValidationError(
        `${before.code} is stored in a shape this screen cannot read, so it has no calculation to keep. Give it one before switching it on or off — saving it as it stands would make it worth nothing.`,
      );
    }
  } else {
    const clash = rows.find((r) => r.code === code);
    if (clash) {
      throw new ConflictError(
        clash.active
          ? `There is already a component with the code ${code}.`
          : `${code} exists but is switched off. Switch it back on rather than adding it again.`,
      );
    }
  }

  const untouched = rows.filter((r) => r.active && r.id !== input.id);

  // A component whose stored `calc` will not parse cannot be carried into a new
  // policy version — it would be published with the placeholder calculation and
  // quietly become worth nothing.
  const malformed = untouched.filter((r) => r.malformed);
  if (malformed.length > 0) {
    throw new ValidationError(
      `${malformed
        .map((c) => c.code)
        .join(", ")} ${malformed.length === 1 ? "is" : "are"} stored in a shape this screen cannot read. Fix ${
        malformed.length === 1 ? "it" : "them"
      } before changing the rest of the structure.`,
    );
  }

  // The set as it would stand after this save, which is what has to be valid —
  // switching off the only earning, or leaving the percentages at 87 %, is
  // refused here rather than discovered on payday.
  const next: SalaryComponent[] = [
    ...untouched.map(toComponent),
    ...(active ? [component] : []),
  ];

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const { policy } = await getPayrollPolicy(ctx, today);

  const issues = validateSalaryStructure(next, policy.percentBase);
  if (issues.length > 0) {
    throw new ValidationError(issues.map((i) => i.message).join(" "), { issues });
  }

  const data = {
    code,
    name: component.name,
    kind: component.kind,
    calc: component.calc as object,
    prorated: component.prorated,
    taxable: component.taxable,
    showOnSlip: component.showOnSlip,
    sortOrder: component.sortOrder,
    active,
  };

  const saved = input.id
    ? await prisma.salaryComponent.update({ where: { id: input.id }, data })
    : await prisma.salaryComponent.create({
        data: { ...data, organizationId: ctx.organizationId },
      });

  // Editing an inactive component, or a field payroll does not read, leaves the
  // paying set identical — and a policy version that changes nothing is noise in
  // a history somebody reads to answer "when did this change?".
  //
  // Otherwise: a policy takes effect from a date, so a month already calculated
  // keeps the component set it was calculated under.
  const version = sameComponentSet(next, policy.components)
    ? null
    : (
        await savePolicyVersion(
          ctx,
          "PAYROLL",
          { ...policy, components: next },
          { effectiveFrom: today, note: `Salary components changed: ${code}` },
        )
      ).version;

  await writeAudit(ctx, {
    action: input.id ? "salary.component_updated" : "salary.component_created",
    entityType: "SalaryComponent",
    entityId: saved.id,
    before: before ? { ...toComponent(before), active: before.active } : undefined,
    after: { ...component, active },
    metadata: { payrollPolicyVersion: version },
  });

  return getSalaryComponents(ctx);
}

// ------------------------------------------------------------------ profiles

export interface SalaryLine {
  code: string;
  name: string;
  amountPaise: number;
  formula: string;
}

export interface SalaryRevision {
  id: string;
  ctcMonthlyPaise: number;
  effectiveFrom: DateOnly;
  effectiveTo: DateOnly | null;
  note: string | null;
  /** The component breakdown frozen at the moment this revision was written. */
  lines: SalaryLine[];
}

export interface SalaryProfileView {
  employee: {
    id: string;
    name: string;
    employeeCode: string;
    joiningDate: DateOnly | null;
  };
  /** The revision in force on `asOf`, if there is one. */
  current: SalaryRevision | null;
  /** Every revision, newest first. */
  history: SalaryRevision[];
  asOf: DateOnly;
  /** The component set a revision dated `asOf` would be built from. */
  components: SalaryComponent[];
  percentBase: PercentBase;
  /** Problems with that set. A revision cannot be written while any remain. */
  issues: StructureIssue[];
  /**
   * The latest month with a locked payroll run, if any. A revision may not start
   * in it or before it, so the screen can bound the date rather than let somebody
   * type one that will be refused.
   */
  lockedThrough: { year: number; month: number } | null;
  canManage: boolean;
}

export interface SalaryRevisionInput {
  ctcMonthlyPaise: number;
  effectiveFrom: DateOnly;
  note?: string;
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10) as DateOnly;
}

/**
 * Somebody outside the caller's visible set is missing, not forbidden.
 *
 * The same scope `getEmployee` applies, so a manager granted
 * `employee.salary.read` for their own team cannot reach the whole organisation's
 * salaries through this endpoint instead.
 */
async function assertVisible(ctx: AuthContext, employeeId: string): Promise<void> {
  const visible = await visibleEmployeeIds(ctx, "employee.read");
  if (visible !== null && !visible.includes(employeeId)) {
    throw new NotFoundError("That employee");
  }
}

function toUtcDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * The frozen breakdown of a stored revision.
 *
 * Read the same tolerant way `services/exit/fnf.ts` reads it: a bare array is
 * what is written, a `{ components }` wrapper is accepted, and anything else
 * yields nothing rather than throwing. A profile written by an older version of
 * this product still has to be listable.
 */
function readLines(structure: unknown): SalaryLine[] {
  const raw = Array.isArray(structure)
    ? structure
    : ((structure as { components?: unknown } | null)?.components ?? []);
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    const line = entry as { code?: unknown; name?: unknown; amountPaise?: unknown; formula?: unknown };
    if (typeof line.code !== "string" || typeof line.amountPaise !== "number") return [];
    return [
      {
        code: line.code,
        name: typeof line.name === "string" ? line.name : line.code,
        amountPaise: line.amountPaise,
        formula: typeof line.formula === "string" ? line.formula : "",
      },
    ];
  });
}

function toRevision(row: {
  id: string;
  ctcMonthlyPaise: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  note: string | null;
  structure: unknown;
}): SalaryRevision {
  return {
    id: row.id,
    ctcMonthlyPaise: row.ctcMonthlyPaise,
    effectiveFrom: toDateOnly(row.effectiveFrom),
    effectiveTo: row.effectiveTo ? toDateOnly(row.effectiveTo) : null,
    note: row.note,
    lines: readLines(row.structure),
  };
}

/**
 * One person's salary, its history, and what a new revision would resolve to.
 *
 * `on` is the date a prospective revision would start, because the component set
 * and the percent base come from the payroll policy in force *then* — which is
 * also what the engine will use when it pays them.
 */
export async function getSalaryProfile(
  ctx: AuthContext,
  employeeId: string,
  on?: DateOnly,
): Promise<SalaryProfileView> {
  requireOrg(ctx);
  requireAnyPermission(ctx, ["employee.salary.read", "employee.salary.manage"]);
  // The same module gate the write carries. A revision cannot be recorded with
  // payroll off, so the history and the worked example behind it are not served
  // either.
  requireModule(ctx, "payroll");

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId: ctx.organizationId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      employeeCode: true,
      joiningDate: true,
    },
  });
  // Never Forbidden for a row in another tenant: a 403 would confirm it exists.
  if (!employee) throw new NotFoundError("That employee");
  await assertVisible(ctx, employeeId);

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const asOf = on && isDateOnly(on) ? on : today;

  const [rows, { policy }, locked] = await Promise.all([
    prisma.salaryProfile.findMany({
      where: { employeeId, organizationId: ctx.organizationId },
      orderBy: { effectiveFrom: "desc" },
      select: {
        id: true,
        ctcMonthlyPaise: true,
        effectiveFrom: true,
        effectiveTo: true,
        note: true,
        structure: true,
      },
    }),
    getPayrollPolicy(ctx, asOf),
    prisma.payrollRun.findFirst({
      where: { organizationId: ctx.organizationId, status: "LOCKED" },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
      select: { periodYear: true, periodMonth: true },
    }),
  ]);

  const history = rows.map(toRevision);

  return {
    employee: {
      id: employee.id,
      name: [employee.firstName, employee.lastName].filter(Boolean).join(" "),
      employeeCode: employee.employeeCode,
      joiningDate: employee.joiningDate ? toDateOnly(employee.joiningDate) : null,
    },
    // The revision in force *today*, which is what the profile screen shows —
    // not the one in force on `asOf`, which may be a date somebody is still
    // considering.
    current:
      history.find(
        (r) => r.effectiveFrom <= today && (r.effectiveTo === null || r.effectiveTo >= today),
      ) ?? null,
    history,
    asOf,
    components: policy.components,
    percentBase: policy.percentBase,
    issues: validateSalaryStructure(policy.components, policy.percentBase),
    lockedThrough: locked ? { year: locked.periodYear, month: locked.periodMonth } : null,
    // Never for your own record, whatever the permission says — `saveSalaryProfile`
    // refuses it, and a view claiming otherwise would put a control on screen
    // that is going to be turned down.
    canManage: hasPermission(ctx, "employee.salary.manage") && ctx.employeeId !== employeeId,
  };
}

/**
 * Records a new salary as a new revision.
 *
 * Never an edit in place. The previous revision is closed the day before this one
 * starts, so payroll for a past month keeps reading exactly what it read then —
 * overwriting a salary silently rewrites history, and the payslip somebody was
 * given stops matching the record it was drawn from.
 */
export async function saveSalaryProfile(
  ctx: AuthContext,
  employeeId: string,
  input: SalaryRevisionInput,
): Promise<SalaryProfileView> {
  requireOrg(ctx);
  requireWrite(ctx, "employee.salary.manage", "payroll");

  // Nobody sets their own pay. `employee.salary.manage` is held by every Admin
  // and can be handed to anybody from the individual permissions screen, and
  // without this an Admin opens their own profile and writes themselves a raise
  // that the next payroll run simply pays. The same rule the rest of the
  // product already applies to approving your own leave, clearing your own
  // attendance and changing your own permissions.
  if (ctx.employeeId && ctx.employeeId === employeeId) {
    throw new ForbiddenError(
      "You cannot set your own salary. Somebody else with permission to manage salaries has to record it.",
    );
  }

  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId: ctx.organizationId },
    select: { id: true, firstName: true, employeeCode: true, joiningDate: true },
  });
  if (!employee) throw new NotFoundError("That employee");
  await assertVisible(ctx, employeeId);

  if (!isDateOnly(input.effectiveFrom)) {
    throw new ValidationError("Give the revision a date in the form YYYY-MM-DD.");
  }
  const effectiveFrom = input.effectiveFrom;

  const ctc = input.ctcMonthlyPaise;
  // Money is integer paise everywhere. A fractional paise here means the caller
  // did the rupee conversion with a float, and it would poison every derived
  // component amount.
  if (!Number.isSafeInteger(ctc) || ctc <= 0) {
    throw new ValidationError("A monthly CTC has to be a whole amount greater than zero.");
  }

  if (employee.joiningDate) {
    const joined = toDateOnly(employee.joiningDate);
    if (effectiveFrom < joined) {
      throw new ValidationError(
        `${employee.firstName} joined on ${joined}, so a salary cannot start before that.`,
      );
    }
  }

  const { year, month } = parts(effectiveFrom);

  // Money that has been paid. A revision starting in a locked month — or in any
  // month before a locked one — would change what that run reads if it is ever
  // recalculated, which is the one thing locking is for.
  const lockedAfter = await prisma.payrollRun.findFirst({
    where: {
      organizationId: ctx.organizationId,
      status: "LOCKED",
      OR: [{ periodYear: { gt: year } }, { periodYear: year, periodMonth: { gte: month } }],
    },
    orderBy: [{ periodYear: "asc" }, { periodMonth: "asc" }],
    select: { periodYear: true, periodMonth: true },
  });
  if (lockedAfter) {
    const name = MONTH_NAMES[lockedAfter.periodMonth - 1] ?? String(lockedAfter.periodMonth);
    throw new ConflictError(
      `${name} ${lockedAfter.periodYear} payroll is locked and has been paid. A revision from ${effectiveFrom} would change what that run reads, so start it after that month — or unlock the run first.`,
    );
  }

  const existing = await prisma.salaryProfile.findMany({
    where: { employeeId, organizationId: ctx.organizationId },
    orderBy: { effectiveFrom: "desc" },
    select: { id: true, ctcMonthlyPaise: true, effectiveFrom: true, effectiveTo: true },
  });

  const latest = existing[0];
  if (latest) {
    const latestFrom = toDateOnly(latest.effectiveFrom);
    if (effectiveFrom === latestFrom) {
      throw new ConflictError(`There is already a revision starting on ${latestFrom}.`);
    }
    if (effectiveFrom < latestFrom) {
      throw new ConflictError(
        `The most recent revision starts on ${latestFrom}. A new one has to start after it — revisions are added, never rewritten.`,
      );
    }
  }

  // The rules in force on the day the revision starts, which is what the engine
  // will use to pay them. Resolving against today's rules instead would produce a
  // breakdown that quietly disagrees with the payslip.
  const { policy } = await getPayrollPolicy(ctx, effectiveFrom);

  const issues = validateSalaryStructure(policy.components, policy.percentBase);
  if (issues.length > 0) {
    throw new ValidationError(
      `The salary structure itself has to be fixed first. ${issues.map((i) => i.message).join(" ")}`,
      { issues },
    );
  }

  const resolved: ResolvedStructure = resolveSalaryStructure(
    ctc,
    policy.components,
    policy.percentBase,
  );

  /**
   * A bare array of earnings, exactly as `prisma/seed.ts` writes it and as
   * `services/exit/fnf.ts` reads it. Not `{ components: [...] }`, and earnings
   * only: a reader that sums this array must get the gross, so deductions — which
   * the engine computes per month from attendance and statutory rules anyway —
   * do not belong in it.
   */
  const structure = resolved.earnings.map((e) => ({
    code: e.component.code,
    name: e.component.name,
    amountPaise: e.amountPaise,
    formula: e.formula,
  }));

  const created = await prisma.$transaction(async (tx) => {
    // Close every revision still open past the new start date. `updateMany`
    // rather than touching only the latest, so a chain left open by an older
    // bug is repaired rather than compounded.
    await tx.salaryProfile.updateMany({
      where: {
        employeeId,
        organizationId: ctx.organizationId,
        effectiveFrom: { lt: toUtcDate(effectiveFrom) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: toUtcDate(effectiveFrom) } }],
      },
      data: { effectiveTo: toUtcDate(addDays(effectiveFrom, -1)) },
    });

    return tx.salaryProfile.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId,
        ctcMonthlyPaise: ctc,
        effectiveFrom: toUtcDate(effectiveFrom),
        structure: structure as object,
        note: input.note?.trim() || null,
        createdById: ctx.userId,
      },
      select: { id: true },
    });
  });

  await writeAudit(ctx, {
    action: "employee.salary_changed",
    entityType: "SalaryProfile",
    entityId: created.id,
    before: latest
      ? {
          ctcMonthlyPaise: latest.ctcMonthlyPaise,
          effectiveFrom: toDateOnly(latest.effectiveFrom),
        }
      : undefined,
    after: {
      ctcMonthlyPaise: ctc,
      effectiveFrom,
      grossPaise: resolved.grossPaise,
      components: structure.length,
    },
    metadata: { employeeCode: employee.employeeCode },
  });

  return getSalaryProfile(ctx, employeeId, effectiveFrom);
}
