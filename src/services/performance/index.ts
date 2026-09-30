import type { GoalStatus, ReviewCycleStatus, ReviewStatus } from "@prisma/client";
import { employeeName } from "@/domain/employees/name";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite, visibleEmployeeIds } from "@/lib/auth/guard";
import { planGoalAssignment } from "@/domain/performance/goalAssignment";
import {
  canEditGoalDefinition,
  canRecordProgress,
  goalPercent,
  validateProgressValue,
} from "@/domain/performance/goalProgress";
import type { RecognitionUnitKey } from "@/domain/recognition/units";
import { LIVE_PRIMARY_LINE } from "@/domain/reporting/primaryLine";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { type DateOnly, todayInZone } from "@/domain/date";

/**
 * Performance reviews.
 *
 * The scoping here is unusual and deliberate: there is no `performance.read.all`
 * permission, so nobody can browse everybody's reviews. What you see is what
 * you are party to — your own review, or the reviews where you are the named
 * reviewer. An HR manager running the cycle sees the *status* of reviews, not
 * their contents.
 *
 * A review moves SELF_REVIEW → MANAGER_REVIEW → COMPLETED, and the employee
 * writes first. A manager who has already recorded a rating changes what the
 * employee is willing to write about themselves.
 */

export const DEFAULT_COMPETENCIES = [
  { code: "DELIVERY", label: "Delivery and ownership", weight: 30 },
  { code: "QUALITY", label: "Quality of work", weight: 25 },
  { code: "COLLABORATION", label: "Collaboration", weight: 20 },
  { code: "COMMUNICATION", label: "Communication", weight: 15 },
  { code: "GROWTH", label: "Learning and growth", weight: 10 },
];

export interface Competency {
  code: string;
  label: string;
  weight: number;
}

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

function readCompetencies(value: unknown): Competency[] {
  if (!Array.isArray(value)) return DEFAULT_COMPETENCIES;
  const parsed = value.flatMap((entry) => {
    const c = entry as { code?: unknown; label?: unknown; weight?: unknown };
    return typeof c.code === "string" && typeof c.label === "string"
      ? [{ code: c.code, label: c.label, weight: typeof c.weight === "number" ? c.weight : 1 }]
      : [];
  });
  return parsed.length > 0 ? parsed : DEFAULT_COMPETENCIES;
}

// ------------------------------------------------------------------ cycles

export async function listCycles(ctx: AuthContext) {
  requireOrg(ctx);
  requirePermission(ctx, "performance.manage");

  const cycles = await prisma.reviewCycle.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { startDate: "desc" },
    select: {
      id: true,
      name: true,
      startDate: true,
      endDate: true,
      status: true,
      competencies: true,
      reviews: { select: { status: true } },
    },
  });

  return cycles.map((c) => ({
    id: c.id,
    name: c.name,
    startDate: toDateOnly(c.startDate),
    endDate: toDateOnly(c.endDate),
    status: c.status,
    competencies: readCompetencies(c.competencies),
    reviews: {
      total: c.reviews.length,
      notStarted: c.reviews.filter((r) => r.status === "NOT_STARTED").length,
      selfReview: c.reviews.filter((r) => r.status === "SELF_REVIEW").length,
      managerReview: c.reviews.filter((r) => r.status === "MANAGER_REVIEW").length,
      completed: c.reviews.filter((r) => r.status === "COMPLETED").length,
    },
  }));
}

export async function createCycle(
  ctx: AuthContext,
  input: { name: string; startDate: DateOnly; endDate: DateOnly; competencies?: Competency[] },
) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.manage", "performance");

  if (input.endDate < input.startDate) {
    throw new ValidationError("The cycle cannot end before it starts.");
  }

  const existing = await prisma.reviewCycle.findFirst({
    where: { organizationId: ctx.organizationId, name: input.name.trim() },
    select: { id: true },
  });
  if (existing) throw new ConflictError("A cycle with that name already exists.");

  const cycle = await prisma.reviewCycle.create({
    data: {
      organizationId: ctx.organizationId,
      name: input.name.trim(),
      startDate: toDate(input.startDate),
      endDate: toDate(input.endDate),
      competencies: (input.competencies ?? DEFAULT_COMPETENCIES) as unknown as object,
      status: "DRAFT",
    },
  });

  return { id: cycle.id };
}

/**
 * Whom opening a cycle reaches: every active employee, split by whether they
 * have a primary manager to write the review.
 *
 * One query, read by `openCycle` and by the count the screen shows before the
 * button is pressed, so "opens for 12, skips 3" is the number the click then
 * produces. The count used to live in the page with its own copy of the rule,
 * and a copy agrees only until one side is edited.
 *
 * The *live* line, not any PRIMARY row. A manager removed on the employee
 * form ends the line rather than deleting it -- the approval they gave in
 * March keeps its manager -- and this matched ended rows too, so a cycle
 * opened after "Nobody" was chosen still handed the review to the manager
 * they no longer had. With the end date in the predicate there is at most one
 * row, which is what makes `take: 1` mean something.
 */
async function reviewableEmployees(ctx: AuthContext & { organizationId: string }) {
  const employees = await prisma.employee.findMany({
    where: { organizationId: ctx.organizationId, active: true },
    select: {
      id: true,
      employeeCode: true,
      userId: true,
      managers: { where: LIVE_PRIMARY_LINE, take: 1, select: { managerId: true } },
    },
  });

  return {
    withManager: employees.filter((e) => e.managers[0]),
    withoutManager: employees.filter((e) => !e.managers[0]),
  };
}

export interface ReviewableHeadcount {
  /** Active employees. */
  total: number;
  /** Of those, the ones with a live primary manager -- the ones who get a review. */
  withManager: number;
}

/**
 * The figures the screen shows beside "Open", since pressing it cannot be
 * undone. Gated as `listCycles` is: the cycle-runner's permission.
 */
export async function reviewableHeadcount(ctx: AuthContext): Promise<ReviewableHeadcount> {
  requireOrg(ctx);
  requirePermission(ctx, "performance.manage");

  const { withManager, withoutManager } = await reviewableEmployees(ctx);
  return {
    total: withManager.length + withoutManager.length,
    withManager: withManager.length,
  };
}

/**
 * Opens a cycle and creates one review per employee.
 *
 * The reviewer is the employee's primary manager. Anybody without one is
 * skipped and reported rather than assigned to whoever opened the cycle — a
 * review by somebody who has not worked with you is worse than none.
 */
export async function openCycle(ctx: AuthContext, cycleId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.manage", "performance");

  const cycle = await prisma.reviewCycle.findFirst({
    where: { id: cycleId, organizationId: ctx.organizationId },
    select: { id: true, name: true, status: true },
  });
  if (!cycle) throw new NotFoundError("That cycle");
  if (cycle.status !== "DRAFT") {
    throw new ConflictError(`That cycle is already ${cycle.status.toLowerCase()}.`);
  }

  const { withManager, withoutManager } = await reviewableEmployees(ctx);

  await prisma.$transaction([
    prisma.reviewCycle.update({ where: { id: cycleId }, data: { status: "ACTIVE" } }),
    prisma.performanceReview.createMany({
      data: withManager.map((e) => ({
        organizationId: ctx.organizationId!,
        cycleId,
        employeeId: e.id,
        reviewerId: e.managers[0]!.managerId,
        status: "SELF_REVIEW" as ReviewStatus,
      })),
      skipDuplicates: true,
    }),
  ]);

  await writeAudit(ctx, {
    action: "performance.cycle_opened",
    entityType: "ReviewCycle",
    entityId: cycleId,
    after: { name: cycle.name, reviews: withManager.length, skipped: withoutManager.length },
  });

  const userIds = withManager.map((e) => e.userId).filter((id): id is string => Boolean(id));
  if (userIds.length > 0) {
    await notify.toUsers(userIds, {
      type: "performance.review",
      title: `${cycle.name} is open`,
      body: "Write your self-review to get started.",
      link: "/performance",
    });
  }

  return {
    opened: withManager.length,
    skipped: withoutManager.map((e) => e.employeeCode),
  };
}

export async function closeCycle(ctx: AuthContext, cycleId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.manage", "performance");

  const open = await prisma.performanceReview.count({
    where: { cycleId, organizationId: ctx.organizationId, status: { not: "COMPLETED" } },
  });
  if (open > 0) {
    throw new ValidationError(`${open} review(s) are still in progress.`);
  }

  await prisma.reviewCycle.update({ where: { id: cycleId }, data: { status: "CLOSED" } });
  return { id: cycleId, status: "CLOSED" as ReviewCycleStatus };
}

// ------------------------------------------------------------------ reviews

export interface ReviewRow {
  id: string;
  status: ReviewStatus;
  cycle: { id: string; name: string; competencies: Competency[] };
  employee: { id: string; name: string; code: string };
  reviewer: { id: string; name: string };
  selfComment: string | null;
  managerComment: string | null;
  selfRating: number | null;
  managerRating: number | null;
  finalRating: number | null;
  ratings: { competency: string; selfScore: number | null; managerScore: number | null; comment: string | null }[];
  /** Which side of it the viewer is on. */
  role: "SUBJECT" | "REVIEWER" | "OBSERVER";
}

/**
 * The reviews this person is party to.
 *
 * Not "all reviews in scope" — there is no permission for that. You see your
 * own and the ones you are named reviewer on.
 */
export async function listReviews(ctx: AuthContext, cycleId?: string): Promise<ReviewRow[]> {
  requireOrg(ctx);
  if (!ctx.employeeId) return [];

  const reviews = await prisma.performanceReview.findMany({
    where: {
      organizationId: ctx.organizationId,
      ...(cycleId ? { cycleId } : {}),
      OR: [{ employeeId: ctx.employeeId }, { reviewerId: ctx.employeeId }],
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      status: true,
      employeeId: true,
      reviewerId: true,
      selfComment: true,
      managerComment: true,
      selfRating: true,
      managerRating: true,
      finalRating: true,
      cycle: { select: { id: true, name: true, competencies: true } },
      employee: { select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } } },
      reviewer: { select: { id: true, firstName: true, lastName: true, user: { select: { name: true } } } },
      ratings: { select: { competency: true, selfScore: true, managerScore: true, comment: true } },
    },
  });

  return reviews.map((r) => ({
    id: r.id,
    status: r.status,
    cycle: {
      id: r.cycle.id,
      name: r.cycle.name,
      competencies: readCompetencies(r.cycle.competencies),
    },
    employee: {
      id: r.employee.id,
      name: employeeName(r.employee, "—"),
      code: r.employee.employeeCode,
    },
    reviewer: { id: r.reviewer.id, name: employeeName(r.reviewer, "—") },
    selfComment: r.selfComment,
    // The manager's words stay hidden until the review is finished.
    managerComment: r.status === "COMPLETED" || r.reviewerId === ctx.employeeId ? r.managerComment : null,
    selfRating: r.selfRating != null ? Number(r.selfRating) : null,
    managerRating:
      r.status === "COMPLETED" || r.reviewerId === ctx.employeeId
        ? r.managerRating != null
          ? Number(r.managerRating)
          : null
        : null,
    finalRating: r.status === "COMPLETED" && r.finalRating != null ? Number(r.finalRating) : null,
    ratings: r.ratings.map((rating) => ({
      competency: rating.competency,
      selfScore: rating.selfScore != null ? Number(rating.selfScore) : null,
      managerScore:
        r.status === "COMPLETED" || r.reviewerId === ctx.employeeId
          ? rating.managerScore != null
            ? Number(rating.managerScore)
            : null
          : null,
      comment: rating.comment,
    })),
    role:
      r.employeeId === ctx.employeeId
        ? "SUBJECT"
        : r.reviewerId === ctx.employeeId
          ? "REVIEWER"
          : "OBSERVER",
  }));
}

export interface SubmitReviewInput {
  reviewId: string;
  comment: string;
  scores: { competency: string; score: number }[];
}

export async function submitSelfReview(ctx: AuthContext, input: SubmitReviewInput) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.read.self", "performance");

  const review = await prisma.performanceReview.findFirst({
    where: { id: input.reviewId, organizationId: ctx.organizationId },
    select: { id: true, employeeId: true, status: true, reviewer: { select: { userId: true } } },
  });
  if (!review) throw new NotFoundError("That review");
  if (review.employeeId !== ctx.employeeId) {
    throw new ForbiddenError("That is not your review.");
  }
  if (review.status !== "SELF_REVIEW") {
    throw new ConflictError(
      review.status === "NOT_STARTED"
        ? "That cycle has not opened yet."
        : "Your self-review has already been submitted.",
    );
  }

  const average = averageScore(input.scores);

  await prisma.$transaction([
    prisma.performanceReview.update({
      where: { id: input.reviewId },
      data: {
        selfComment: input.comment.trim() || null,
        selfRating: average,
        status: "MANAGER_REVIEW",
        submittedAt: new Date(),
      },
    }),
    ...input.scores.map((s) =>
      prisma.reviewRating.upsert({
        where: { reviewId_competency: { reviewId: input.reviewId, competency: s.competency } },
        create: { reviewId: input.reviewId, competency: s.competency, selfScore: s.score },
        update: { selfScore: s.score },
      }),
    ),
  ]);

  await writeAudit(ctx, {
    action: "performance.review_submitted",
    entityType: "PerformanceReview",
    entityId: input.reviewId,
    after: { by: "employee", selfRating: average },
  });

  if (review.reviewer.userId) {
    await notify.toUser(review.reviewer.userId, {
      type: "performance.review",
      title: "A self-review is ready for you",
      body: `${ctx.name ?? "Somebody in your team"} has submitted theirs.`,
      link: "/performance",
    });
  }

  return { id: input.reviewId, status: "MANAGER_REVIEW" as const };
}

export async function submitManagerReview(
  ctx: AuthContext,
  input: SubmitReviewInput & { finalRating?: number },
) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.review", "performance");

  const review = await prisma.performanceReview.findFirst({
    where: { id: input.reviewId, organizationId: ctx.organizationId },
    select: { id: true, reviewerId: true, status: true, employee: { select: { userId: true } } },
  });
  if (!review) throw new NotFoundError("That review");
  if (review.reviewerId !== ctx.employeeId) {
    throw new ForbiddenError("You are not the reviewer for that review.");
  }
  if (review.status !== "MANAGER_REVIEW") {
    throw new ConflictError(
      review.status === "SELF_REVIEW"
        ? "Wait for the self-review before writing yours."
        : "That review is already complete.",
    );
  }

  const average = averageScore(input.scores);

  await prisma.$transaction([
    prisma.performanceReview.update({
      where: { id: input.reviewId },
      data: {
        managerComment: input.comment.trim() || null,
        managerRating: average,
        finalRating: input.finalRating ?? average,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    }),
    ...input.scores.map((s) =>
      prisma.reviewRating.upsert({
        where: { reviewId_competency: { reviewId: input.reviewId, competency: s.competency } },
        create: { reviewId: input.reviewId, competency: s.competency, managerScore: s.score },
        update: { managerScore: s.score },
      }),
    ),
  ]);

  await writeAudit(ctx, {
    action: "performance.review_completed",
    entityType: "PerformanceReview",
    entityId: input.reviewId,
    after: { managerRating: average, finalRating: input.finalRating ?? average },
  });

  if (review.employee.userId) {
    await notify.toUser(review.employee.userId, {
      type: "performance.review",
      title: "Your review is complete",
      body: "Your manager has finished their part. You can read it now.",
      link: "/performance",
    });
  }

  return { id: input.reviewId, status: "COMPLETED" as const };
}

function averageScore(scores: { score: number }[]): number {
  if (scores.length === 0) return 0;
  const total = scores.reduce((sum, s) => sum + s.score, 0);
  return Math.round((total / scores.length) * 100) / 100;
}

// ------------------------------------------------------------------ goals

export interface GoalProgressRow {
  id: string;
  value: number;
  note: string | null;
  at: string;
}

export interface GoalRow {
  id: string;
  title: string;
  description: string | null;
  weight: number;
  /** The free-text pair, from before either was a number. Still honoured. */
  targetValue: string | null;
  currentValue: string | null;
  unit: RecognitionUnitKey | null;
  targetNumber: number | null;
  currentNumber: number | null;
  /** Null when the goal has no number to measure against, never zero. */
  percent: number | null;
  /**
   * Worked out here rather than in the component, so a screen never offers a
   * control the service will refuse -- and so the rule lives in one place.
   */
  canRecordProgress: boolean;
  canEdit: boolean;
  recentProgress: GoalProgressRow[];
  status: GoalStatus;
  dueOn: DateOnly | null;
  cycleName: string | null;
  overdue: boolean;
  /** Whose goal it is. On every row, so a screen never has to guess. */
  employee: { id: string; name: string; code: string };
}

/**
 * The employees `ctx` may set a goal for, out of the ids it named.
 *
 * Both goal entry points resolve their targets here, so "somebody I can set a
 * goal for" means the same thing for one person and for fifty: in my
 * organisation, and inside my visible scope — a team lead sets goals along
 * their reporting line, HR for the company. Anything else is simply absent from
 * the result, and the caller refuses.
 */
async function resolveGoalTargets(
  ctx: AuthContext & { organizationId: string },
  employeeIds: string[],
): Promise<{ id: string; userId: string | null }[]> {
  const visible = await visibleEmployeeIds(ctx, "employee.read");
  // Null means *no restriction*. Reading it as "nothing is visible" would stop
  // every HR manager from setting anybody a goal.
  const candidates =
    visible !== null ? employeeIds.filter((id) => visible.includes(id)) : employeeIds;

  return prisma.employee.findMany({
    where: { id: { in: candidates }, organizationId: ctx.organizationId },
    select: { id: true, userId: true },
  });
}

/**
 * Goals the viewer may see.
 *
 * With nobody named: your own, plus everybody in your visible scope if you
 * review people — which is what lets the screen say whose goal each one is.
 * Somebody holding only `performance.read.self` sees exactly their own, as
 * before.
 */
export async function listGoals(ctx: AuthContext, employeeId?: string): Promise<GoalRow[]> {
  requireOrg(ctx);

  const target = employeeId ?? ctx.employeeId;
  if (!target) return [];

  const reviewsOthers = ctx.permissions.has("performance.review");
  if (target !== ctx.employeeId && !reviewsOthers) {
    throw new ForbiddenError("You can only see your own goals.");
  }

  const visible = await visibleEmployeeIds(ctx, "employee.read");

  let where: { organizationId: string; employeeId?: string | { in: string[] } };
  if (employeeId) {
    // Asking after one person you may not see is answered the way a missing row
    // is: confirming the id exists would confirm the person does.
    if (visible !== null && !visible.includes(employeeId)) {
      throw new NotFoundError("That employee");
    }
    where = { organizationId: ctx.organizationId, employeeId };
  } else if (reviewsOthers) {
    where = {
      organizationId: ctx.organizationId,
      ...(visible !== null ? { employeeId: { in: visible } } : {}),
    };
  } else {
    where = { organizationId: ctx.organizationId, employeeId: target };
  }

  const goals = await prisma.goal.findMany({
    where,
    orderBy: [{ status: "asc" }, { dueOn: "asc" }],
    select: {
      id: true,
      title: true,
      description: true,
      weight: true,
      targetValue: true,
      currentValue: true,
      unit: true,
      targetNumber: true,
      currentNumber: true,
      employeeId: true,
      status: true,
      dueOn: true,
      progress: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { id: true, value: true, note: true, createdAt: true },
      },
      cycle: { select: { id: true, name: true } },
      employee: {
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          user: { select: { name: true } },
        },
      },
    },
  });

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");

  return goals.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    weight: Number(g.weight),
    targetValue: g.targetValue,
    currentValue: g.currentValue,
    unit: g.unit,
    targetNumber: g.targetNumber === null ? null : Number(g.targetNumber),
    currentNumber: g.currentNumber === null ? null : Number(g.currentNumber),
    percent: goalPercent({
      unit: g.unit,
      target: g.targetNumber === null ? null : Number(g.targetNumber),
      current: g.currentNumber === null ? null : Number(g.currentNumber),
    }),
    // Whether *this* reader may record against it, worked out here so the
    // screen never offers a control the service will refuse.
    canRecordProgress: canRecordProgress({
      isOwnGoal: g.employeeId === ctx.employeeId,
      canReview: reviewsOthers,
    }),
    canEdit: canEditGoalDefinition({
      isOwnGoal: g.employeeId === ctx.employeeId,
      canReview: reviewsOthers,
    }),
    recentProgress: g.progress.map((p) => ({
      id: p.id,
      value: Number(p.value),
      note: p.note,
      at: p.createdAt.toISOString(),
    })),
    status: g.status,
    dueOn: g.dueOn ? toDateOnly(g.dueOn) : null,
    cycleName: g.cycle?.name ?? null,
    overdue: Boolean(g.dueOn && toDateOnly(g.dueOn) < today && g.status === "ACTIVE"),
    employee: {
      id: g.employee.id,
      name: employeeName(g.employee, "—"),
      code: g.employee.employeeCode,
    },
  }));
}

/** A cycle id from a client is only a cycle id if it is this tenant's. */
async function resolveCycleId(
  ctx: AuthContext & { organizationId: string },
  cycleId: string | undefined,
): Promise<string | null> {
  if (!cycleId) return null;
  const cycle = await prisma.reviewCycle.findFirst({
    where: { id: cycleId, organizationId: ctx.organizationId },
    select: { id: true },
  });
  if (!cycle) throw new NotFoundError("That cycle");
  return cycle.id;
}

export async function upsertGoal(
  ctx: AuthContext,
  input: {
    id?: string;
    employeeId: string;
    title: string;
    description?: string;
    weight?: number;
    targetValue?: string;
    currentValue?: string;
    unit?: RecognitionUnitKey | null;
    targetNumber?: number | null;
    status?: GoalStatus;
    dueOn?: DateOnly;
    cycleId?: string;
  },
) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.read.self", "performance");

  const data = {
    title: input.title.trim(),
    description: input.description?.trim() || null,
    weight: input.weight ?? 1,
    targetValue: input.targetValue?.trim() || null,
    currentValue: input.currentValue?.trim() || null,
    // A target with no unit is a bare number nobody can read, and a unit with
    // no target measures nothing -- so one without the other stores neither.
    unit: input.targetNumber != null ? (input.unit ?? "COUNT") : null,
    targetNumber: input.unit != null && input.targetNumber != null ? input.targetNumber : null,
    status: input.status ?? "ACTIVE",
    dueOn: input.dueOn ? toDate(input.dueOn) : null,
    cycleId: await resolveCycleId(ctx, input.cycleId),
  };

  let goal: { id: string; title: string; status: GoalStatus };

  if (input.id) {
    /**
     * This was `prisma.goal.update({ where: { id: input.id }, data })`: no
     * organisation in the `where`, no check on whose goal it is, and the only
     * ownership test in the function read `input.employeeId` — a field the
     * caller supplies. So anybody signed in could send their own employee id
     * together with any goal id in the database and rewrite that goal: another
     * team's, or another organisation's. Title, status and due date of a
     * stranger's goal, editable by id.
     *
     * The row is loaded scoped to this tenant first, and who may touch it is
     * decided from the employee on the row rather than from the request. A
     * foreign id matches nothing and reads as a 404, which is all another
     * tenant should ever learn.
     */
    const existing = await prisma.goal.findFirst({
      where: { id: input.id, organizationId: ctx.organizationId },
      select: { id: true, employeeId: true },
    });
    if (!existing) throw new NotFoundError("That goal");

    /**
     * Editing a goal is a reviewer's act, even on your own goal.
     *
     * "Goal aur target edit na kar sake" -- somebody handed a goal moves the
     * number that says how far they have got, through `recordGoalProgress`, and
     * nothing else. Otherwise a target is a suggestion: the person being
     * measured could lower it the day before it was measured.
     *
     * A goal you set for yourself is the same object once it exists, so the
     * rule is the permission and not the ownership. Somebody without
     * `performance.review` can still create one; they cannot rewrite it
     * afterwards.
     */
    if (!canEditGoalDefinition({ isOwnGoal: existing.employeeId === ctx.employeeId, canReview: ctx.permissions.has("performance.review") })) {
      throw new ForbiddenError(
        "Only somebody who can review performance changes a goal once it is set. You can record how far along it is.",
      );
    }
    if (existing.employeeId !== ctx.employeeId) {
      const [owner] = await resolveGoalTargets(ctx, [existing.employeeId]);
      if (!owner) throw new NotFoundError("That goal");
    }

    // Scoped on the write as well, and `employeeId` is not in `data` — editing
    // a goal never re-points it at somebody else.
    const updated = await prisma.goal.updateMany({
      where: { id: existing.id, organizationId: ctx.organizationId },
      data,
    });
    if (updated.count === 0) throw new NotFoundError("That goal");
    goal = { id: existing.id, title: data.title, status: data.status };
  } else {
    const own = input.employeeId === ctx.employeeId;
    if (!own && !ctx.permissions.has("performance.review")) {
      throw new ForbiddenError("You can only set your own goals.");
    }
    // Creation was scoped no better than the update: `organizationId` came from
    // the session while `employeeId` came from the request, so a goal could be
    // hung on an employee belonging to another organisation.
    const [target] = await resolveGoalTargets(ctx, [input.employeeId]);
    if (!target) throw new NotFoundError("That employee");

    goal = await prisma.goal.create({
      data: {
        ...data,
        organizationId: ctx.organizationId,
        employeeId: target.id,
        createdById: ctx.userId,
      },
      select: { id: true, title: true, status: true },
    });
  }

  await writeAudit(ctx, {
    action: "goal.updated",
    entityType: "Goal",
    entityId: goal.id,
    after: { title: goal.title, status: goal.status },
  });

  return { id: goal.id };
}

/**
 * Removing a goal.
 *
 * `upsertGoal` has accepted an `id` since it was written and no client ever
 * sent one, and there was no delete at all -- so a goal typed in by mistake
 * stayed on somebody's list for ever, and `GoalStatus.ACHIEVED` was rendered by
 * the list and reachable from nothing.
 *
 * Scoped and resolved the same way the update is: the row is loaded within this
 * tenant first, and the decision is made from the employee on the row rather
 * than from the request.
 */
export async function deleteGoal(ctx: AuthContext, goalId: string) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.read.self", "performance");

  const existing = await prisma.goal.findFirst({
    where: { id: goalId, organizationId: ctx.organizationId },
    select: { id: true, employeeId: true, title: true },
  });
  if (!existing) throw new NotFoundError("That goal");

  if (
    !canEditGoalDefinition({
      isOwnGoal: existing.employeeId === ctx.employeeId,
      canReview: ctx.permissions.has("performance.review"),
    })
  ) {
    throw new ForbiddenError("Only somebody who can review performance removes a goal.");
  }
  if (existing.employeeId !== ctx.employeeId) {
    const [owner] = await resolveGoalTargets(ctx, [existing.employeeId]);
    if (!owner) throw new NotFoundError("That goal");
  }

  await prisma.goal.deleteMany({
    where: { id: existing.id, organizationId: ctx.organizationId },
  });

  await writeAudit(ctx, {
    action: "goal.updated",
    entityType: "Goal",
    entityId: existing.id,
    before: { title: existing.title },
    metadata: { deleted: true },
  });

  return { id: existing.id };
}

/**
 * How far along a goal has got, recorded again.
 *
 * A log rather than a column, because "kitna hua" is asked repeatedly and the
 * answer worth having is the shape of it. The figure on the goal is written
 * from the entry in the same transaction, so the goal and the trail behind it
 * cannot disagree.
 *
 * The value is the running total, not the increment: "sales are at 60,000 now"
 * is what somebody types, and how much that was up by is arithmetic anybody can
 * do. Taking increments would mean a double-tap silently adding twice.
 */
export async function recordGoalProgress(
  ctx: AuthContext,
  input: { goalId: string; value: number; note?: string },
) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.read.self", "performance");

  const goal = await prisma.goal.findFirst({
    where: { id: input.goalId, organizationId: ctx.organizationId },
    select: { id: true, employeeId: true, title: true, targetNumber: true, unit: true },
  });
  if (!goal) throw new NotFoundError("That goal");

  const isOwnGoal = goal.employeeId === ctx.employeeId;
  const canReview = ctx.permissions.has("performance.review");
  if (!canRecordProgress({ isOwnGoal, canReview })) {
    throw new ForbiddenError("You can only record progress on your own goals.");
  }
  if (!isOwnGoal) {
    const [owner] = await resolveGoalTargets(ctx, [goal.employeeId]);
    if (!owner) throw new NotFoundError("That goal");
  }

  if (goal.targetNumber === null) {
    throw new ValidationError(
      "This goal has no number to measure against. Give it a target first.",
    );
  }

  const checked = validateProgressValue(input.value);
  if (!checked.ok) throw new ValidationError(checked.reason);

  await prisma.$transaction([
    prisma.goalProgress.create({
      data: {
        organizationId: ctx.organizationId!,
        goalId: goal.id,
        value: checked.value,
        note: input.note?.trim() || null,
        createdById: ctx.userId,
      },
    }),
    prisma.goal.updateMany({
      where: { id: goal.id, organizationId: ctx.organizationId },
      data: { currentNumber: checked.value },
    }),
  ]);

  await writeAudit(ctx, {
    action: "goal.updated",
    entityType: "Goal",
    entityId: goal.id,
    after: { currentNumber: checked.value },
    metadata: { progress: true },
  });

  return {
    id: goal.id,
    currentNumber: checked.value,
    percent: goalPercent({
      unit: goal.unit,
      target: Number(goal.targetNumber),
      current: checked.value,
    }),
  };
}

export interface AssignGoalInput {
  employeeIds: string[];
  title: string;
  description?: string;
  weight?: number;
  targetValue?: string;
  status?: GoalStatus;
  dueOn?: DateOnly;
  cycleId?: string;
}

/**
 * One goal, several people.
 *
 * A goal belongs to exactly one employee — there is no join table and nothing
 * org-wide — so assigning to five people is five rows, written together. In one
 * transaction because a half-written assignment is the worst outcome available:
 * the admin is told it worked, and two of the five are never told about the
 * goal they will be reviewed against.
 *
 * The audit gets one row naming the count rather than one per person: this was
 * one decision, by one person, at one moment, and fifty rows would bury it. The
 * notification goes the other way and is per person, because "a goal was set
 * for you" is only true of the person reading it — unlike the employee import,
 * where one summary goes to an HR desk being told a fact about other people.
 */
export async function assignGoal(ctx: AuthContext, input: AssignGoalInput) {
  requireOrg(ctx);
  requireWrite(ctx, "performance.review", "performance");

  const targets = await resolveGoalTargets(ctx, input.employeeIds);
  const plan = planGoalAssignment(
    input.employeeIds,
    targets.map((t) => t.id),
  );

  if (plan.unresolved.length > 0) {
    // Not "write the ones that resolved". Refusing is what keeps the count the
    // admin is shown honest, and an id from another tenant is answered as
    // missing rather than denied.
    throw new NotFoundError(
      plan.unresolved.length === 1 ? "One of those people" : "Some of those people",
    );
  }
  if (plan.employeeIds.length === 0) {
    throw new ValidationError("Choose at least one person to set this goal for.");
  }

  const title = input.title.trim();
  const cycleId = await resolveCycleId(ctx, input.cycleId);
  const loginOf = new Map(targets.map((t) => [t.id, t.userId]));

  await prisma.$transaction([
    prisma.goal.createMany({
      data: plan.employeeIds.map((employeeId) => ({
        organizationId: ctx.organizationId,
        employeeId,
        cycleId,
        title,
        description: input.description?.trim() || null,
        weight: input.weight ?? 1,
        targetValue: input.targetValue?.trim() || null,
        status: input.status ?? "ACTIVE",
        dueOn: input.dueOn ? toDate(input.dueOn) : null,
        createdById: ctx.userId,
      })),
    }),
  ]);

  await writeAudit(ctx, {
    action: "goal.assigned",
    entityType: "Goal",
    after: { title, employees: plan.employeeIds.length, dueOn: input.dueOn ?? null },
  });

  // Somebody with no login gets the goal and no notification: the row is what
  // matters, and a missing user id is a person who cannot be told anything.
  const userIds = plan.employeeIds
    .map((id) => loginOf.get(id))
    .filter((id): id is string => Boolean(id));
  if (userIds.length > 0) {
    await notify.toUsers(userIds, {
      type: "performance.goal",
      title: "A goal was set for you",
      body: `${ctx.name ?? "Somebody"} set you a goal: ${title}`,
      link: "/performance",
    });
  }

  return { assigned: plan.employeeIds.length, employeeIds: plan.employeeIds };
}
