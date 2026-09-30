import { requireContext } from "@/lib/auth/context";
import { route } from "@/lib/http/handler";
import { exportMyData } from "@/services/employees/selfExport";

/**
 * "What do you hold about me?" — answered directly, to the person asking.
 *
 * No id in the path and none accepted in a query: the only record this can
 * produce is the caller's own, which is what makes it safe to leave open to
 * every employee without a permission.
 */
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const ctx = await requireContext();
  const data = await exportMyData(ctx);

  const name = data.about.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase() || "my-data";
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}-${data.generatedAt.slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
