import { prisma } from "./db/prisma";
import { BRAND } from "./brand";

/**
 * Who this instance says it is.
 *
 * Three names can appear at once and they mean different things:
 *
 *   - **the product** — HRMS, what the software is called
 *   - **the maker** — Broadmate Global, who built it, credited everywhere
 *   - **the organisation** — the customer whose data this is
 *
 * The signed-out screens have a problem the signed-in ones do not: they cannot
 * know which organisation somebody belongs to until they have typed an email.
 *
 * This used to be answered by inference — *"if the instance holds exactly one
 * organisation, it is that organisation's instance"* — and that was wrong. The
 * first real customer's name, logo and PWA manifest took over the front door of
 * the product itself, so `hrms.broadmate.org` advertised a company that merely
 * happened to be first. **The only thing that names an organisation now is the
 * URL**: `/o/<slug>` is theirs, everything else is Broadmate's.
 *
 * These are read on pages that render before authentication, so they must never
 * throw: a database that is unreachable falls back to the built-in brand rather
 * than turning the login screen into an error.
 */

export interface Branding {
  /** The product name, always present. */
  product: string;
  tagline: string;
  maker: { name: string; credit: string; website: string; websiteLabel: string };
  /**
   * The customer, and only when the URL named one.
   *
   * `id` is here so a tenant sign-in page can narrow the login candidate set to
   * that organisation. It is not a secret: the login route verifies the password
   * against every candidate before this is applied, so it can only ever filter
   * a set the caller has already authenticated into.
   */
  organization: { id: string; name: string; slug: string; logoUrl: string | null } | null;
  /** Platform-level mark, set by the Superadmin. Overrides the letter mark. */
  platformLogoUrl: string | null;
}

export const FALLBACK_BRANDING: Branding = {
  product: BRAND.name,
  tagline: BRAND.tagline,
  maker: { ...BRAND.maker },
  organization: null,
  platformLogoUrl: null,
};

/** Slugs are `[a-z0-9-]`; anything else cannot match a row, so do not ask. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The organisation at this address, including addresses it has left behind.
 *
 * `/o/<slug>` is printed on emails, bookmarked, and baked into the start URL of
 * every installed PWA, so a rename would otherwise strand all three at once --
 * the old address still loads, and resolves to nobody.
 *
 * Resolved rather than redirected, deliberately. A redirect would move the
 * browser to the new address, and an installed app whose manifest is re-fetched
 * from a URL that redirects is an app whose identity the browser may decide has
 * changed. Answering at the old address costs one extra query only when the
 * first one misses, and nothing about the install has to move.
 */
async function organizationAtSlug(slug: string) {
  const current = await prisma.organization.findFirst({
    where: { slug, status: { not: "SUSPENDED" } },
    select: { id: true, name: true, slug: true, logoKey: true },
  });
  if (current) return current;

  const past = await prisma.organizationSlug.findUnique({
    where: { slug },
    select: {
      organization: {
        select: { id: true, name: true, slug: true, logoKey: true, status: true },
      },
    },
  });
  if (!past || past.organization.status === "SUSPENDED") return null;

  // The organisation's *current* slug is returned, never the one that was
  // asked for. Everything downstream builds links and icon URLs from it, and
  // handing back the old one would keep it alive for ever.
  const { status: _status, ...org } = past.organization;
  return org;
}

export function isSlugShaped(slug: string | null | undefined): slug is string {
  return typeof slug === "string" && SLUG.test(slug);
}

async function platformLogoUrl(): Promise<string | null> {
  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { logoKey: true },
  });
  return settings?.logoKey ? `/api/branding/platform-logo` : null;
}

/**
 * The front door. Never a customer — see the note above.
 */
export async function resolveBranding(): Promise<Branding> {
  try {
    return { ...FALLBACK_BRANDING, platformLogoUrl: await platformLogoUrl() };
  } catch {
    return FALLBACK_BRANDING;
  }
}

/**
 * Branding for a tenant entry URL.
 *
 * An unknown, malformed or suspended slug returns the platform branding rather
 * than an error: a signed-out page that distinguishes "no such organisation"
 * from "wrong password" tells the internet which customers exist here.
 */
export async function brandingForSlug(slug: string | null): Promise<Branding> {
  try {
    const platform = await platformLogoUrl();
    if (!isSlugShaped(slug)) return { ...FALLBACK_BRANDING, platformLogoUrl: platform };


    const org = await organizationAtSlug(slug);

    return {
      ...FALLBACK_BRANDING,
      platformLogoUrl: platform,
      organization: org
        ? {
            id: org.id,
            name: org.name,
            slug: org.slug,
            logoUrl: org.logoKey ? `/api/branding/logo?org=${encodeURIComponent(org.slug)}` : null,
          }
        : null,
    };
  } catch {
    return FALLBACK_BRANDING;
  }
}

/**
 * The logo key behind a tenant entry URL, for the public logo and icon routes.
 * Returns null for anything that is not a live organisation, so those routes
 * answer 404 rather than falling back to somebody else's mark.
 */
export async function publicLogoKeyForSlug(slug: string | null): Promise<string | null> {
  if (!isSlugShaped(slug)) return null;
  // Through the same resolver, so an icon requested with an address the
  // organisation has left behind is still theirs. The installed app asks for
  // exactly that: its manifest was fetched under the old slug.
  const org = await organizationAtSlug(slug);
  return org?.logoKey ?? null;
}

/**
 * Branding for a signed-in screen.
 *
 * Unlike the signed-out resolvers there is no ambiguity: the caller already
 * belongs to exactly one organisation, so its name and logo are simply theirs.
 *
 * The logo comes from the authenticated file route rather than the public
 * `/api/branding/logo`, because that one answers only for a slug that was asked
 * for by name — correct for a sign-in screen, wrong for a shell that already
 * knows who is looking.
 *
 * Like the others, it never throws. The shell wraps every screen in the
 * product; a database hiccup should cost a logo, not the page.
 */
export async function shellBranding(organizationId: string | null): Promise<Branding> {
  try {
    const [organization, platform] = await Promise.all([
      organizationBranding(organizationId),
      platformLogoUrl(),
    ]);

    return { ...FALLBACK_BRANDING, organization, platformLogoUrl: platform };
  } catch {
    return FALLBACK_BRANDING;
  }
}

/**
 * The organisation shown to somebody already signed in — no ambiguity here,
 * they belong to exactly one.
 */
export async function organizationBranding(
  organizationId: string | null,
): Promise<{ id: string; name: string; slug: string; logoUrl: string | null } | null> {
  if (!organizationId) return null;
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, slug: true, logoKey: true },
  });
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    logoUrl: org.logoKey ? `/api/files/${org.logoKey}` : null,
  };
}
