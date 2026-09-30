import crypto from "node:crypto";
import { runMaintenanceJobs } from "@/lib/jobs";

/**
 * The maintenance pass, triggered by the scheduler.
 *
 * Not behind `route()`: there is no session here. The caller is a cron task on
 * the host, and it proves itself with a shared secret rather than a cookie.
 *
 * Everything unauthenticated returns **404, not 401**. A 401 confirms the
 * endpoint exists and invites guessing; a 404 says nothing at all, which is the
 * right answer to give someone who should not be asking.
 */

// @unreachable-ok a cron schedule calls this with JOBS_SECRET; no screen should
export const dynamic = "force-dynamic";

const notFound = () => new Response(null, { status: 404 });

function authorised(request: Request): boolean {
  const expected = process.env.JOBS_SECRET;

  // No secret configured means the endpoint is off, not open. This is the
  // default in development, where the script is the way to run these.
  if (!expected || expected.length < 32) return false;

  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length, so compare that first and in a way that cannot short-circuit early.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorised(request)) return notFound();

  try {
    const summary = await runMaintenanceJobs();
    console.log("[jobs] maintenance pass complete", summary);
    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // The scheduler needs a non-2xx so a failed pass is visible in its history;
    // the detail belongs in the server log, not in the response.
    console.error("[jobs] maintenance pass failed", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}
