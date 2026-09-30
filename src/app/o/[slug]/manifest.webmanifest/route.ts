import { buildManifest, MANIFEST_HEADERS } from "@/lib/manifest";

/**
 * One organisation's manifest.
 *
 * Installing from `/o/<slug>` gives their name and their icon; installing from
 * the product's own front door gives Broadmate's. That split is the whole
 * reason this route exists separately from the root manifest.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  return Response.json(await buildManifest(slug), { headers: MANIFEST_HEADERS });
}
