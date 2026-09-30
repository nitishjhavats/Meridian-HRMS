import Link from "next/link";
import { resolveBranding } from "@/lib/branding";
import { BrandMark } from "@/components/brand/BrandMark";
import { AuthShowcase } from "@/components/brand/AuthShowcase";
import { MakerCredit } from "@/components/brand/MakerCredit";

/**
 * Shell for the signed-out screens.
 *
 * Two columns on desktop, one on mobile — the showcase is hidden rather than
 * squashed, because on a phone the only thing that matters is the form.
 *
 * Both marks appear on purpose: the organisation's name and logo say whose
 * screen this is, and the Broadmate Global credit says who built it.
 *
 * On this layout there is no organisation. It used to infer one — "if the
 * instance holds exactly one customer, it is theirs" — and that inference put
 * the first real customer's name, logo and PWA manifest on the product's own
 * front door. A customer's branding now appears only where the URL names them,
 * at `/o/<slug>`.
 */
export const dynamic = "force-dynamic";
/**
 * Never indexed. A tenant door names a customer, and a sign-in form is not
 * something anybody should reach from a search result.
 */
export const metadata = { robots: { index: false, follow: false } };

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const branding = await resolveBranding();

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <main id="main" className="flex flex-col justify-center px-5 py-10 sm:px-10">
        <div className="mx-auto w-full max-w-sm">
          <Link href="/" className="mb-8 inline-flex">
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
