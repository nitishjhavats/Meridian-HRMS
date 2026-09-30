import { buildManifest, MANIFEST_HEADERS } from "@/lib/manifest";

/**
 * The office device's own manifest.
 *
 * One difference from the app's, and it is the whole reason this exists: no
 * orientation lock. A reception tablet is mounted however the office mounted
 * it, usually landscape, and an installed app honours `portrait-primary` where
 * a browser tab ignores it -- so installing the kiosk flipped the screen and
 * dropped the roster from four columns to one.
 *
 * It takes the organisation from `?org=`, which `generateMetadata` in the kiosk
 * layout puts there. It cannot take it from the session: a manifest is fetched
 * without credentials unless the link says otherwise, so this route ran
 * anonymously and handed every reception tablet Broadmate's mark instead of the
 * logo of the company whose reception it stands in.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("org");
  return Response.json(await buildManifest(slug, "kiosk"), { headers: MANIFEST_HEADERS });
}
