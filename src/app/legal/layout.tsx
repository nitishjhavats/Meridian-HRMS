import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { resolveBranding } from "@/lib/branding";
import { BrandMark } from "@/components/brand/BrandMark";
import { MakerCredit } from "@/components/brand/MakerCredit";
import { LEGAL_PAGES } from "@/lib/legal";

/**
 * The legal pages.
 *
 * Public and indexable — unlike everything else outside the landing page — for
 * two reasons. A policy nobody can read is not a policy, and search engines and
 * payment gateways both expect to find these at a stable, public URL.
 *
 * Broadmate's branding only. These describe what Broadmate Global does with
 * data, not what any particular customer does, so `resolveBranding` is right
 * here and a tenant's mark would be actively misleading.
 */
export const dynamic = "force-dynamic";

export default async function LegalLayout({ children }: { children: React.ReactNode }) {
  const branding = await resolveBranding();

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
          <Link href="/" className="inline-flex">
            <BrandMark branding={branding} size="sm" />
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Back
          </Link>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
        {children}

        <nav aria-label="Legal" className="mt-12 border-t border-border pt-6">
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {LEGAL_PAGES.map((page) => (
              <li key={page.href}>
                <Link
                  href={page.href}
                  className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {page.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8">
          <MakerCredit logoUrl={branding.platformLogoUrl} />
        </div>
      </footer>
    </div>
  );
}
