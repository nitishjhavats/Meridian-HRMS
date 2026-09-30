import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { requireContext } from "@/lib/auth/context";

/**
 * The office device gets its own shell, which is to say none.
 *
 * No sidebar, no notifications, no user menu, nothing to wander into. A screen
 * left in a reception is used by people who are not signed in as themselves, and
 * every link that goes anywhere else is a link they should not be following.
 *
 * Anyone who is not a kiosk is sent back to their own part of the product rather
 * than shown an empty screen.
 */
/**
 * The device points at its own manifest, not the app's, and at its own icon.
 *
 * Route metadata overrides the root layout's, so a tablet installed from
 * `/kiosk` gets the variant with no orientation lock and stays mounted the way
 * the office mounted it.
 *
 * **The slug is in the URL on purpose.** A manifest is fetched without
 * credentials unless the link says otherwise, so a route that tried to read the
 * device's session would find none and fall back to the platform mark -- which
 * is what happened: every reception tablet installed itself under Broadmate's
 * logo rather than the logo of the company whose reception it stands in. The
 * slug is not a secret; it is in the tenant entry URL already.
 *
 * `generateMetadata` rather than a constant because the answer depends on which
 * organisation this device belongs to, which is a database read.
 */
export async function generateMetadata(): Promise<Metadata> {
  const ctx = await requireContext().catch(() => null);
  const slug = ctx?.organization?.slug ?? null;
  const query = slug ? `?org=${encodeURIComponent(slug)}` : "";

  return {
    manifest: `/kiosk/manifest.webmanifest${query}`,
    icons: {
      // The tab and the iOS home screen, which do not read the manifest at all.
      icon: [{ url: `/api/branding/icon/192${query}`, sizes: "192x192", type: "image/png" }],
      apple: [{ url: `/api/branding/icon/192${query}`, sizes: "192x192" }],
    },
  };
}

export const dynamic = "force-dynamic";

export default async function KioskLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext().catch(() => null);
  if (!ctx) redirect("/login");
  if (!ctx.permissions.has("attendance.kiosk.operate")) {
    redirect(ctx.isSuperadmin ? "/platform" : "/dashboard");
  }

  // No height here. `KioskScreen` is `h-dvh` and owns the frame; a `min-h-dvh`
  // wrapper around it only gave the document something extra to scroll.
  return <div className="bg-background">{children}</div>;
}
