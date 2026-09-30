import { publicLogoKeyForSlug } from "@/lib/branding";
import { storage } from "@/lib/storage";

/**
 * An organisation's logo, served without a session.
 *
 * Everything else in `/api/files` is behind authentication and a tenant check,
 * and rightly so. A logo is the exception: it has to render on the sign-in
 * screen, before anyone has proved who they are. It is public branding by
 * nature — the same image a company puts on its website.
 *
 * **It is served only for a slug that was asked for by name.** It used to answer
 * with "the only organisation's" logo whenever the instance held exactly one,
 * which is how the product's front door ended up serving a customer's mark to
 * the internet. No slug now means no logo, not a guess.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("org");
  const key = await publicLogoKeyForSlug(slug);
  if (!key) return new Response(null, { status: 404 });

  const file = await storage().get(key);
  if (!file) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.data.length),
      // Public, but short-lived: a logo change should show up the same day.
      // Varying on the query string is implicit, but say so for any proxy in
      // front that normalises it away.
      "Cache-Control": "public, max-age=600",
      Vary: "Accept-Encoding",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
