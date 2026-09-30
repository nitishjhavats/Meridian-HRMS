import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { publicLogoKeyForSlug } from "@/lib/branding";
import { storage } from "@/lib/storage";
import { composeBrandIcon } from "@/lib/branding/icon";

/**
 * A PWA icon rendered from whichever logo this instance is branded with.
 *
 * An installed app whose icon is the generic product mark is indistinguishable
 * from every other install on the home screen, so the logo an organisation
 * uploads becomes the icon they tap.
 *
 * How it is fitted depends on the logo. One that is already a designed square
 * tile -- opaque, roughly square, margins its designer chose -- is used as it
 * is; anything else is `contain`-fitted on a drawn ground, because a wordmark
 * cropped to a square is unreadable and a transparent PNG turns into a dark
 * smudge on a dark launcher. The decision and the safe margins live in
 * `@/lib/branding/icon`, where they can be measured by a test.
 *
 * Which logo depends on who asked. `?org=<slug>` is that organisation's entry
 * URL installing its own app, so their mark wins. With no slug this is the
 * product's own icon: the platform mark if the Superadmin set one, otherwise the
 * shipped default. It never falls back to a customer's logo — that is how the
 * front door came to wear somebody else's branding.
 */

export const dynamic = "force-dynamic";

const SIZES = [192, 256, 384, 512] as const;

async function brandingLogoKey(slug: string | null): Promise<string | null> {
  if (slug) return publicLogoKeyForSlug(slug);

  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { logoKey: true },
  });
  return settings?.logoKey ?? null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ size: string }> },
) {
  const { size: raw } = await context.params;
  const size = Number(raw);
  if (!SIZES.includes(size as (typeof SIZES)[number])) {
    return new Response(null, { status: 404 });
  }

  const params = new URL(request.url).searchParams;
  const key = await brandingLogoKey(params.get("org"));

  /**
   * With no logo anywhere, serve the shipped mark rather than a 404.
   *
   * This route is the only apple-touch-icon the product declares, and iOS asks
   * for exactly one URL. A 404 there is not a fallback — it is an install with
   * no icon at all. `public/` ships with the image; the Dockerfile copies it.
   */
  const file = key ? await storage().get(key) : null;
  const source = file
    ? file.data
    : await readFile(path.join(process.cwd(), "public", "icons", "icon-512.png")).catch(
        () => null,
      );
  if (!source) return new Response(null, { status: 404 });

  const maskable = params.get("maskable") === "1";
  const png = await composeBrandIcon(source, size, maskable ? "maskable" : "any");

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.length),
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
