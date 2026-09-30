import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import type { DateOnly } from "@/domain/date";
import { json, parseBody, route } from "@/lib/http/handler";
import { getAttendanceSettings, updateAttendanceSettings } from "@/services/attendance/settings";

export const GET = route(async () => {
  const ctx = await requireContext();
  return json(await getAttendanceSettings(ctx));
});

/**
 * The whole policy, not a patch.
 *
 * The thresholds refine against each other — a late threshold is only valid
 * relative to the grace period and the half-day threshold — so there is no
 * meaningful way to validate one of them in isolation. The form sends the
 * complete shape and the service validates it as a whole.
 *
 * Shapes are deliberately loose here: `attendancePolicySchema` in the domain is
 * the single authority on what a valid policy is, and duplicating it at the edge
 * is how the two drift apart.
 */
const bodySchema = z.object({
  policy: z.unknown(),
  faceMatch: z.unknown(),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-30")
    .optional(),
  note: z.string().trim().max(300).optional(),
});

export const PUT = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, bodySchema);
  // Spread out rather than passed through: `z.unknown()` infers an *optional*
  // property, and the service requires both to be present even when their value
  // is undefined — that distinction is the whole point of the required fields.
  return json(
    await updateAttendanceSettings(ctx, {
      policy: body.policy,
      faceMatch: body.faceMatch,
      effectiveFrom: body.effectiveFrom as DateOnly | undefined,
      note: body.note,
    }),
  );
});
