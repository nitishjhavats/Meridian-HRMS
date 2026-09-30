import { buildManifest, MANIFEST_HEADERS } from "@/lib/manifest";

/**
 * The product's own manifest.
 *
 * Deliberately takes no organisation. This used to name whichever customer
 * happened to be the only one on the instance, which meant installing HRMS from
 * its own front door gave you an app called after somebody else's company. A
 * customer's manifest is served from their own entry URL instead.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await buildManifest(null), { headers: MANIFEST_HEADERS });
}
