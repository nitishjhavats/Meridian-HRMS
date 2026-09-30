import { z } from "zod";
import { json, parseBody, parseQuery, route } from "@/lib/http/handler";
import { adjustBalance, listBalances } from "@/services/leave/balances";

/**
 * The balance grid, and adjustments to it.
 *
 * A save returns the whole grid rather than the row it changed: an adjustment
 * moves `available`, which is arithmetic the client would otherwise have to
 * repeat, and repeating it is how two screens start disagreeing. The filters
 * come back on the write so the grid returned is the grid the user is looking
 * at, not the unfiltered one.
 */

const filterSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  employeeId: z.string().min(1).optional(),
  leaveTypeId: z.string().min(1).optional(),
});

/**
 * Days, not paise: leave is counted in halves and stored as `Decimal(6,2)`.
 * The half-day step and the sanity ceiling are the service's to enforce, so its
 * wording is what a user reads.
 */
const days = z.number().min(0).max(9999);

const adjustSchema = z.object({
  employeeId: z.string().min(1),
  leaveTypeId: z.string().min(1),
  year: z.number().int().min(2000).max(2100),
  allocated: days.optional(),
  carriedForward: days.optional(),
  reason: z.string().trim().min(5).max(500),
  /** What the grid should come back showing. */
  filters: filterSchema.optional(),
});

export const GET = route(async (request, { ctx }) => {
  const filters = parseQuery(request, filterSchema);
  return json(await listBalances(ctx, filters));
});

export const POST = route(async (request, { ctx }) => {
  const body = await parseBody(request, adjustSchema);
  await adjustBalance(ctx, body);
  return json(await listBalances(ctx, body.filters ?? { year: body.year }));
});
