import { requireContext } from "@/lib/auth/context";
import { json, route } from "@/lib/http/handler";
import { getMonthlyGrid } from "@/services/attendance/admin";

/**
 * One month of one person, for the calendar and the month report.
 *
 * `employeeId` is optional and defaults to the caller, which is what makes the
 * same component work on somebody own screen and on a profile. The scope check
 * is `getMonthlyGrid`s own: a team lead asking about somebody outside their
 * team gets an empty result rather than a refusal, the same as the matrix.
 */
export const GET = route(async (request) => {
  const ctx = await requireContext();
  const params = new URL(request.url).searchParams;
  const now = new Date();

  const year = Number(params.get("year")) || now.getUTCFullYear();
  const month = Number(params.get("month")) || now.getUTCMonth() + 1;
  const employeeId = params.get("employeeId") ?? ctx.employeeId ?? undefined;

  return json(await getMonthlyGrid(ctx, { year, month, employeeId }));
});
