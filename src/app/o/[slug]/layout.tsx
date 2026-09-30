import type { Metadata } from "next";
import Link from "next/link";
import { brandingForSlug } from "@/lib/branding";
import { BrandMark } from "@/components/brand/BrandMark";
import { AuthShowcase } from "@/components/brand/AuthShowcase";
import { MakerCredit } from "@/components/brand/MakerCredit";

/**
 * An organisation's own front door.
 *
 * The same shell as the signed-out screens, with one difference that is the
 * whole point of this route: the URL names an organisation, so this is the one
 * place a customer's name and logo may appear before anybody has signed in.
 *
 * `/` and `/login` deliberately show neither. Inferring the customer from "there
 * is only one of them" is what put the first real customer's branding — and
 * their name in the PWA manifest — on the product's own homepage.
 *
 * An unknown or suspended slug falls back to plain Broadmate branding rather
 * than erroring, so this page cannot be used to find out which organisations
 * exist here.
 */
export const dynamic = "force-dynamic";
/**
 * The icons and the manifest this door installs with, and never an index:
 * a tenant door names a customer, and a sign-in form is not something anybody
 * should reach from a search result.
 *
 * The manifest here has always carried the organisation's logo, so an Android
 * install showed their mark. The `<link rel="apple-touch-icon">` did not --
 * the root layout hard-codes the product icon and nothing overrode it -- so the
 * same organisation installing the same URL on an iPhone got Broadmate's mark
 * on their home screen. Same for the tab favicon.
 *
 * Generated per request rather than statically, because the logo is an upload
 * that can change; `/api/branding/icon` caches for ten minutes.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const branding = await brandingForSlug(slug);
  const org = branding.organization;

  // No logo anywhere means the shipped product icons, which is what the root
  // layout already provides -- so add nothing rather than a broken URL.
  if (!org?.logoUrl && !branding.platformLogoUrl) {
    return { robots: { index: false, follow: false } };
  }

  const query = org ? `?org=${encodeURIComponent(org.slug)}` : "";
  return {
    robots: { index: false, follow: false },
    manifest: `/o/${slug}/manifest.webmanifest`,
    icons: {
      icon: [
        { url: `/api/branding/icon/192${query}`, sizes: "192x192", type: "image/png" },
      ],
      // iOS applies its own rounded mask and does not read `purpose`, so it gets
      // the padded plain icon rather than the maskable one.
      apple: [{ url: `/api/branding/icon/192${query}`, sizes: "180x180" }],
    },
  };
}

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const branding = await brandingForSlug(slug);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main id="main" className="flex flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <Link href={`/o/${slug}`} className="mb-8 inline-flex">
            <BrandMark branding={branding} />
          </Link>

          {children}

          <MakerCredit
            logoUrl={branding.platformLogoUrl}
            className="mt-8 justify-center lg:hidden"
          />
        </div>
      </main>

      <AuthShowcase branding={branding} />
    </div>
  );
}
