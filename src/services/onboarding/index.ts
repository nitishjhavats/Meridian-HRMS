import type { TaskStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { type DateOnly, addDays, todayInZone } from "@/domain/date";
import { moveStep } from "@/domain/onboarding/template";

/**
 * Onboarding.
 *
 * A template is a list of things that must happen for a new joiner, each with an
 * offset from their joining date. Applying it produces real dated tasks — the
 * template is not referenced live, so editing it later does not silently move
 * somebody's deadlines or resurrect a task they already completed.
 */

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/** Enough to be useful on day one without anybody configuring anything. */
export const STARTER_TEMPLATE = [
  { title: "Send the offer and appointment letter", dueOffsetDays: -7, sortOrder: 1 },
  { title: "Collect identity and address proof", dueOffsetDays: -3, sortOrder: 2 },
  { title: "Collect bank details for salary", dueOffsetDays: -1, sortOrder: 3 },
  { title: "Create email and system accounts", dueOffsetDays: 0, sortOrder: 4 },
  { title: "Issue laptop and access card", dueOffsetDays: 0, sortOrder: 5 },
  { title: "Enrol reference photo for attendance", dueOffsetDays: 0, sortOrder: 6 },
  { title: "Introduce to the team and assign a buddy", dueOffsetDays: 1, sortOrder: 7 },
  { title: "Walk through leave and attendance policy", dueOffsetDays: 2, sortOrder: 8 },
  { title: "Set goals for the first month", dueOffsetDays: 7, sortOrder: 9 },
  { title: "First-week check-in", dueOffsetDays: 7, sortOrder: 10 },
];

// ------------------------------------------------------------------ templates

export async function listTemplates(ctx: AuthContext) {
  requireOrg(ctx);
  requirePermission(ctx, "onboarding.manage");

  return prisma.onboardingTemplate.findMany({
    where: { organizationId: ctx.organizationId, active: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      tasks: {
        orderBy: { sortOrder: "asc" },
        select: { id: true, title: true, description: true, dueOffsetDays: true, sortOrder: true },
      },
      _count: { select: { issued: true } },
    },
  });
}

export async function createTemplate(
  ctx: AuthContext,
  input: {
    name: string;
    description?: string;
    tasks?: { title: string; dueOffsetDays: number; description?: string }[];
    /** Start with no steps instead of the starter list, and add them by hand. */
    blank?: boolean;
  },
) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the template a name.");

  const existing = await prisma.onboardingTemplate.findFirst({
    where: { organizationId: ctx.organizationId, name },
    select: { id: true },
  });
  if (existing) throw new ConflictError("A template with that name already exists.");

  const starting = input.tasks?.length ? input.tasks : input.blank ? [] : STARTER_TEMPLATE;

  const tasks = starting.map((t, i) => ({
    title: t.title.trim(),
    description: "description" in t ? (t.description?.trim() || null) : null,
    dueOffsetDays: t.dueOffsetDays,
    sortOrder: i + 1,
  }));

  const template = await prisma.onboardingTemplate.create({
    data: {
      organizationId: ctx.organizationId,
      name,
      description: input.description?.trim() || null,
      tasks: { create: tasks },
    },
  });

  return { id: template.id, tasks: tasks.length };
}

export async function deleteTemplate(ctx: AuthContext, id: string) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  const template = await prisma.onboardingTemplate.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true },
  });
  if (!template) throw new NotFoundError("That template");

  // Deactivated rather than deleted: tasks already issued from it keep their
  // provenance, and the name stays taken so it cannot be silently reused.
  await prisma.onboardingTemplate.update({ where: { id }, data: { active: false } });
  return { id };
}

// -------------------------------------------------------------- template steps

/**
 * The template, or a 404.
 *
 * Scoped by `organizationId` rather than checked afterwards, so an id belonging
 * to another organisation matches nothing and reads as "no such template"
 * instead of confirming that it exists somewhere.
 */
async function ownedTemplate(ctx: AuthContext & { organizationId: string }, id: string) {
  const template = await prisma.onboardingTemplate.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { id: true, name: true },
  });
  if (!template) throw new NotFoundError("That template");
  return template;
}

export async function renameTemplate(
  ctx: AuthContext,
  input: { id: string; name: string; description?: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  const template = await ownedTemplate(ctx, input.id);

  const name = input.name.trim();
  if (name.length < 2) throw new ValidationError("Give the template a name.");

  const clash = await prisma.onboardingTemplate.findFirst({
    where: { organizationId: ctx.organizationId, name, NOT: { id: template.id } },
    select: { id: true },
  });
  if (clash) throw new ConflictError("A template with that name already exists.");

  await prisma.onboardingTemplate.update({
    where: { id: template.id },
    data: {
      name,
      // Absent means "leave the description alone"; an empty string clears it.
      ...(input.description === undefined ? {} : { description: input.description.trim() || null }),
    },
  });

  return { id: template.id };
}

export async function addTemplateStep(
  ctx: AuthContext,
  input: { templateId: string; title: string; dueOffsetDays: number; description?: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  const template = await ownedTemplate(ctx, input.templateId);

  const title = input.title.trim();
  if (title.length < 2) throw new ValidationError("Give the step a title.");

  const last = await prisma.onboardingTemplateTask.aggregate({
    where: { templateId: template.id },
    _max: { sortOrder: true },
  });

  const step = await prisma.onboardingTemplateTask.create({
    data: {
      templateId: template.id,
      title,
      description: input.description?.trim() || null,
      dueOffsetDays: input.dueOffsetDays,
      sortOrder: (last._max.sortOrder ?? 0) + 1,
    },
  });

  return { id: step.id };
}

export async function removeTemplateStep(
  ctx: AuthContext,
  input: { templateId: string; stepId: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  const template = await ownedTemplate(ctx, input.templateId);

  const step = await prisma.onboardingTemplateTask.findFirst({
    where: { id: input.stepId, templateId: template.id },
    select: { id: true },
  });
  if (!step) throw new NotFoundError("That step");

  // Only the template changes. Tasks already issued from it are copies, so
  // nobody's checklist loses a line they were part-way through.
  await prisma.onboardingTemplateTask.delete({ where: { id: step.id } });

  return { id: step.id };
}

export async function moveTemplateStep(
  ctx: AuthContext,
  input: { templateId: string; stepId: string; direction: -1 | 1 },
) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  const template = await ownedTemplate(ctx, input.templateId);

  const steps = await prisma.onboardingTemplateTask.findMany({
    where: { templateId: template.id },
    orderBy: { sortOrder: "asc" },
    select: { id: true },
  });
  if (!steps.some((s) => s.id === input.stepId)) throw new NotFoundError("That step");

  const order = moveStep(
    steps.map((s) => s.id),
    input.stepId,
    input.direction,
  );

  // Rewritten as 1..n every time: templates created before this screen existed
  // can have duplicate or gapped sort orders, and a swap of two values would
  // preserve the ambiguity instead of settling it.
  await prisma.$transaction(
    order.map((id, index) =>
      prisma.onboardingTemplateTask.update({ where: { id }, data: { sortOrder: index + 1 } }),
    ),
  );

  return { order };
}

// ------------------------------------------------------------------ applying

export async function applyTemplate(
  ctx: AuthContext,
  input: { employeeId: string; templateId: string; ownerUserId?: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  const [employee, template] = await Promise.all([
    prisma.employee.findFirst({
      where: { id: input.employeeId, organizationId: ctx.organizationId },
      select: { id: true, userId: true, joiningDate: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
    }),
    prisma.onboardingTemplate.findFirst({
      where: { id: input.templateId, organizationId: ctx.organizationId },
      select: { id: true, name: true, tasks: { orderBy: { sortOrder: "asc" } } },
    }),
  ]);
  if (!employee) throw new NotFoundError("That employee");
  if (!template) throw new NotFoundError("That template");
  if (!employee.joiningDate) {
    throw new ValidationError("That employee has no joining date, so nothing can be scheduled.");
  }
  if (template.tasks.length === 0) {
    // Without this the call succeeds having created nothing, and the joiner is
    // notified that "0 onboarding steps have been set up for you".
    throw new ValidationError("That template has no steps yet. Add at least one step first.");
  }

  const existing = await prisma.onboardingTask.count({
    where: { employeeId: input.employeeId, templateId: input.templateId },
  });
  if (existing > 0) {
    throw new ConflictError("That template has already been applied to this employee.");
  }

  const joined = toDateOnly(employee.joiningDate);

  await prisma.onboardingTask.createMany({
    data: template.tasks.map((task) => ({
      organizationId: ctx.organizationId!,
      employeeId: input.employeeId,
      templateId: template.id,
      title: task.title,
      description: task.description,
      // Dates are computed now and stored: editing the template later must not
      // move a deadline somebody is already working to.
      dueOn: toDate(addDays(joined, task.dueOffsetDays)),
      ownerUserId: input.ownerUserId ?? ctx.userId,
      sortOrder: task.sortOrder,
    })),
  });

  await writeAudit(ctx, {
    action: "onboarding.assigned",
    entityType: "Employee",
    entityId: input.employeeId,
    after: { template: template.name, tasks: template.tasks.length, joiningDate: joined },
  });

  if (employee.userId) {
    // The link stays /onboarding and the *page* was opened up instead, because
    // the alternative — pointing the joiner at the dashboard — is a welcome
    // message that shows them nothing of what it announces. `onboarding.manage`
    // could not simply be widened: it is organisation-wide edit rights with no
    // scope check behind it, which is why Managers and Team Leads are excluded
    // from it. So the page reads `listMyTasks` for anyone without it.
    await notify.toUser(employee.userId, {
      type: "onboarding.assigned",
      title: "Welcome — here is what happens next",
      body: `${template.tasks.length} onboarding steps have been set up for you.`,
      link: "/onboarding",
    });
  }

  return { assigned: template.tasks.length };
}

// ------------------------------------------------------------------ tasks

export interface OnboardingTaskRow {
  id: string;
  title: string;
  description: string | null;
  dueOn: DateOnly | null;
  status: TaskStatus;
  note: string | null;
  /** True when it is past due and not done — the reason this list is sorted. */
  overdue: boolean;
  employee: { id: string; name: string; code: string; joiningDate: DateOnly | null };
}

export async function listTasks(
  ctx: AuthContext,
  filters: { employeeId?: string; openOnly?: boolean } = {},
): Promise<OnboardingTaskRow[]> {
  requireOrg(ctx);
  requirePermission(ctx, "onboarding.manage");

  const tasks = await prisma.onboardingTask.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(filters.employeeId ? { employeeId: filters.employeeId } : {}),
      ...(filters.openOnly ? { status: { in: ["PENDING", "IN_PROGRESS"] } } : {}),
    },
    orderBy: [{ status: "asc" }, { dueOn: "asc" }, { sortOrder: "asc" }],
    take: 500,
    select: {
      id: true,
      title: true,
      description: true,
      dueOn: true,
      status: true,
      note: true,
      employee: {
        select: {
          id: true,
          employeeCode: true,
          joiningDate: true,
          firstName: true,
          lastName: true,
          user: { select: { name: true } },
        },
      },
    },
  });

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");

  return tasks.map((t) => {
    const dueOn = t.dueOn ? toDateOnly(t.dueOn) : null;
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      dueOn,
      status: t.status,
      note: t.note,
      overdue: Boolean(
        dueOn && dueOn < today && (t.status === "PENDING" || t.status === "IN_PROGRESS"),
      ),
      employee: {
        id: t.employee.id,
        name: employeeName(t.employee, "—"),
        code: t.employee.employeeCode,
        joiningDate: t.employee.joiningDate ? toDateOnly(t.employee.joiningDate) : null,
      },
    };
  });
}

export interface MyOnboardingTask {
  id: string;
  title: string;
  description: string | null;
  dueOn: DateOnly | null;
  status: TaskStatus;
  overdue: boolean;
}

/**
 * The signed-in person's own onboarding, read only.
 *
 * No permission is required beyond having an employee record, the same way the
 * rest of the self-service pages work: the `where` is pinned to
 * `ctx.employeeId` and `ctx.organizationId`, so there is nothing here to widen.
 * Ticking a step is still HR's job — a joiner marking their own laptop as
 * issued would be a record of nothing.
 */
export async function listMyTasks(ctx: AuthContext): Promise<MyOnboardingTask[]> {
  requireOrg(ctx);
  requireModule(ctx, "onboarding");
  if (!ctx.employeeId) return [];

  const tasks = await prisma.onboardingTask.findMany({
    where: { organizationId: ctx.organizationId, employeeId: ctx.employeeId },
    orderBy: [{ dueOn: "asc" }, { sortOrder: "asc" }],
    take: 200,
    select: {
      id: true,
      title: true,
      description: true,
      dueOn: true,
      status: true,
    },
  });

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");

  return tasks.map((t) => {
    const dueOn = t.dueOn ? toDateOnly(t.dueOn) : null;
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      dueOn,
      status: t.status,
      overdue: Boolean(
        dueOn && dueOn < today && (t.status === "PENDING" || t.status === "IN_PROGRESS"),
      ),
    };
  });
}

export async function setTaskStatus(
  ctx: AuthContext,
  taskId: string,
  status: TaskStatus,
  note?: string,
) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  const task = await prisma.onboardingTask.findFirst({
    where: { id: taskId, organizationId: ctx.organizationId },
    select: { id: true, title: true, status: true, employeeId: true },
  });
  if (!task) throw new NotFoundError("That task");

  const done = status === "COMPLETED" || status === "SKIPPED";

  await prisma.onboardingTask.update({
    where: { id: taskId },
    data: {
      status,
      note: note?.trim() || null,
      completedAt: done ? new Date() : null,
      completedById: done ? ctx.userId : null,
    },
  });

  if (status === "COMPLETED") {
    const open = await prisma.onboardingTask.count({
      where: { employeeId: task.employeeId, status: { in: ["PENDING", "IN_PROGRESS"] } },
    });
    if (open === 0) {
      await writeAudit(ctx, {
        action: "onboarding.completed",
        entityType: "Employee",
        entityId: task.employeeId,
        after: { completed: true },
      });
    }
  }

  return { id: taskId, status };
}

export async function addTask(
  ctx: AuthContext,
  input: { employeeId: string; title: string; dueOn?: DateOnly },
) {
  requireOrg(ctx);
  requireWrite(ctx, "onboarding.manage", "onboarding");

  // The employee id came from the client and was written straight through. An
  // id from another organisation produced a task row stamped with *this*
  // organisation's id and that employee's, which `listTasks` would then read
  // back and display — a foreign name and code on this screen.
  const employee = await prisma.employee.findFirst({
    where: { id: input.employeeId, organizationId: ctx.organizationId },
    select: { id: true },
  });
  if (!employee) throw new NotFoundError("That employee");

  const task = await prisma.onboardingTask.create({
    data: {
      organizationId: ctx.organizationId,
      employeeId: employee.id,
      title: input.title.trim(),
      dueOn: input.dueOn ? toDate(input.dueOn) : null,
      ownerUserId: ctx.userId,
      sortOrder: 999,
    },
  });

  return { id: task.id };
}
