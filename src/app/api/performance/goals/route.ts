import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import {
  assignGoal,
  deleteGoal,
  listGoals,
  recordGoalProgress,
  upsertGoal,
} from "@/services/performance";

export const GET = route(async (request, { ctx }) => {
  const { employeeId } = parseQuery(request, z.object({ employeeId: z.string().optional() }));
  return json({ goals: await listGoals(ctx, employeeId) });
});

const common = {
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  weight: z.number().min(0).max(100).optional(),
  targetValue: z.string().trim().max(120).optional(),
  // The measure. Nullable rather than merely optional, so a goal that had a
  // target can have it taken away again -- omitting the field would leave the
  // old one in place and there would be no way back to a text goal.
  unit: z.enum(["RUPEES", "COUNT", "PERCENT", "HOURS", "POINTS"]).nullable().optional(),
  targetNumber: z.number().min(0).max(1_000_000_000).nullable().optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ACHIEVED", "MISSED", "CANCELLED"]).optional(),
  dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cycleId: z.string().optional(),
};

const oneSchema = z.object({
  ...common,
  id: z.string().optional(),
  employeeId: z.string().min(1),
  currentValue: z.string().trim().max(120).optional(),
});

/**
 * The same goal for several people.
 *
 * A separate shape rather than an optional array on the one above: the two
 * write different numbers of rows and check different permissions, and a body
 * that could carry both would leave "which did the caller mean" to be guessed
 * server-side. The cap is what one screen can reasonably show ticked — beyond
 * it, this is an import, not a form.
 */
const manySchema = z.object({
  ...common,
  employeeIds: z.array(z.string().min(1)).min(1).max(500),
});

/**
 * How far along a goal has got.
 *
 * Its own shape and not an optional field on the goal body, because the two
 * check different things: recording progress is something the person being
 * measured may do, and editing the goal is not.
 */
const progressSchema = z.object({
  goalId: z.string().min(1),
  progressValue: z.number(),
  note: z.string().trim().max(300).optional(),
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, z.union([progressSchema, manySchema, oneSchema]));

  if ("progressValue" in body) {
    return json(
      await recordGoalProgress(ctx, {
        goalId: body.goalId,
        value: body.progressValue,
        note: body.note,
      }),
    );
  }
  if ("employeeIds" in body) {
    return json(await assignGoal(ctx, body), { status: 201 });
  }
  return json(await upsertGoal(ctx, body), { status: body.id ? 200 : 201 });
});

export const DELETE = route(async (request, { ctx }) => {
  const { id } = parseQuery(request, z.object({ id: z.string().min(1) }));
  return json(await deleteGoal(ctx, id));
});
