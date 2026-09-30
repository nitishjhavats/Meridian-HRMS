import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { listReviews, submitManagerReview, submitSelfReview } from "@/services/performance";

export const GET = route(async (request, { ctx }) => {
  const { cycleId } = parseQuery(request, z.object({ cycleId: z.string().optional() }));
  return json({ reviews: await listReviews(ctx, cycleId) });
});

const scores = z.array(
  z.object({ competency: z.string().min(1), score: z.number().min(0).max(5) }),
);

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("self"),
    reviewId: z.string().min(1),
    comment: z.string().trim().max(5000),
    scores,
  }),
  z.object({
    action: z.literal("manager"),
    reviewId: z.string().min(1),
    comment: z.string().trim().max(5000),
    scores,
    finalRating: z.number().min(0).max(5).optional(),
  }),
]);

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, schema);
  return body.action === "self"
    ? json(await submitSelfReview(ctx, body))
    : json(await submitManagerReview(ctx, body));
});
