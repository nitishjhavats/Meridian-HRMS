import { BRAND } from "./brand";
import { brandingForSlug, isSlugShaped } from "./branding";

/**
 * The web app manifest, shared by the front door and by each tenant entry URL.
 *
 * It cannot be a static file in `public/`, because an organisation that installs
 * from their own `/o/<slug>` should get their name and their logo on the home
 * screen rather than a generic mark identical to every other install.
 *
 * What it must *not* do — and used to — is let the customer's identity leak onto
 * the product's own front door. `slug === null` is Broadmate's manifest, always,
 * however many organisations exist.
 */

const ICON_SIZES = [192, 256, 384, 512] as const;

export async function buildManifest(
  slug: string | null,
  /**
   * The office-device manifest.
   *
   * A reception tablet is mounted however the office mounted it, usually
   * landscape, and `orientation: "portrait-primary"` is honoured by an
   * installed app where a browser tab ignores it -- so installing the kiosk
   * flipped the screen and dropped the roster from four columns to one. This
   * variant carries no orientation at all; the employee app keeps portrait.
   */
  variant: "app" | "kiosk" = "app",
) {
  const branding = await brandingForSlug(slug);
  const org = branding.organization;
  /**
   * Where the installed app opens.
   *
   * A tenant install opens their entry URL; the product's own opens the front
   * door. A device install opens the device screen -- it took a slug for its
   * *branding* only, and without this line naming a slug would have sent every
   * reception tablet to the tenant sign-in page instead of to its own roster.
   */
  const scope =
    variant === "kiosk" ? "/kiosk" : isSlugShaped(slug) && org ? `/o/${org.slug}` : "/";
  const orgQuery = org ? `?org=${encodeURIComponent(org.slug)}` : "";

  // The organisation's own logo when they have one, else the platform mark, else
  // the shipped product icons.
  const hasLogo = Boolean(org?.logoUrl) || Boolean(branding.platformLogoUrl);

  const icons = hasLogo
    ? [
        ...ICON_SIZES.map((size) => ({
          src: `/api/branding/icon/${size}${orgQuery}`,
          sizes: `${size}x${size}`,
          type: "image/png",
          purpose: "any",
        })),
        ...[192, 512].map((size) => ({
          src: `/api/branding/icon/${size}${orgQuery ? `${orgQuery}&` : "?"}maskable=1`,
          sizes: `${size}x${size}`,
          type: "image/png",
          purpose: "maskable",
        })),
      ]
    : [
        ...ICON_SIZES.map((size) => ({
          src: `/icons/icon-${size}.png`,
          sizes: `${size}x${size}`,
          type: "image/png",
          purpose: "any",
        })),
        ...[192, 512].map((size) => ({
          src: `/icons/maskable-${size}.png`,
          sizes: `${size}x${size}`,
          type: "image/png",
          purpose: "maskable",
        })),
      ];

  const shortcutIcon = [{ src: icons[0]!.src, sizes: icons[0]!.sizes }];

  return {
    name: org ? `${org.name} — ${BRAND.name}` : `${BRAND.name} — ${BRAND.tagline}`,
    short_name: org ? org.name : BRAND.name,
    description: `Attendance, leave, payroll, documents and letters for your organisation. ${BRAND.maker.credit} (${BRAND.maker.websiteLabel}).`,
    id: scope,
    start_url: scope,
    // Scope stays "/" even for a tenant install: the signed-in app lives on flat
    // paths, and a scope of /o/<slug> would push every screen after sign-in out
    // of the installed window and into the browser.
    scope: "/",
    display: "standalone",
    // `window-controls-overlay` was first, and nothing in this product reads
    // `env(titlebar-area-*)` -- so on a desktop install the page was drawn into
    // the title bar and the window buttons sat on top of the kiosk's clock and
    // sign-out.
    display_override: ["standalone", "minimal-ui"],
    ...(variant === "kiosk" ? {} : { orientation: "portrait-primary" as const }),
    background_color: "#f7f8fb",
    theme_color: "#3b4cca",
    lang: "en-IN",
    dir: "ltr",
    categories: ["business", "productivity"],
    prefer_related_applications: false,
    icons,
    shortcuts: [
      {
        name: "Check in",
        short_name: "Check in",
        description: "Mark today's attendance",
        url: "/me/attendance",
        icons: shortcutIcon,
      },
      {
        name: "Apply for leave",
        short_name: "Leave",
        description: "Raise a leave request",
        url: "/me/leave",
        icons: shortcutIcon,
      },
      {
        name: "Salary slips",
        short_name: "Payslips",
        description: "View and download your salary slips",
        url: "/me/salary",
        icons: shortcutIcon,
      },
    ],
  };
}

export const MANIFEST_HEADERS = {
  "Content-Type": "application/manifest+json",
  "Cache-Control": "public, max-age=300",
} as const;
