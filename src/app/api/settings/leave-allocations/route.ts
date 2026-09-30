import { z } from "zod";
import { requireContext } from "@/lib/auth/context";
import { json, parseBody, route } from "@/lib/http/handler";
import {
  getDesignationAllocations,
  setDesignationAllocation,
  setDesignationWeekOffs,
} from "@/services/leave/designationAllocation";

export const GET = route(async () => {
  const ctx = await requireContext();
  return json(await getDesignationAllocations(ctx));
});

const patchSchema = z.union([
  z.object({
    leaveTypeId: z.string().min(1),
    designationId: z.string().min(1),
    // Null removes the override and follows the leave type again, which is a
    // real choice and not the same as allocating zero days.
    days: z.number().min(0).max(365).nullable(),
  }),
  z.object({
    designationId: z.string().min(1),
    // Same distinction: null follows the payroll rule, 0 means no week offs.
    weekOffsPerMonth: z.number().int().min(0).max(31).nullable(),
  }),
]);

export const PATCH = route(async (request) => {
  const ctx = await requireContext();
  const body = await parseBody(request, patchSchema);
  return json(
    "weekOffsPerMonth" in body
      ? await setDesignationWeekOffs(ctx, body)
      : await setDesignationAllocation(ctx, body),
  );
});
