/**
 * Product branding.
 *
 * Kept in one place so the name, the maker's credit and the website appear
 * identically on the login screen, in the app shell, in the PWA manifest, and on
 * every PDF the product generates — rather than being retyped in a dozen files
 * and drifting apart.
 */

export const BRAND = {
  /** The product itself. */
  name: "HRMS",
  tagline: "HR, Attendance & Payroll",

  /** Who makes it. */
  maker: {
    name: "Broadmate Global",
    credit: "by Broadmate Global",
    website: "https://broadmate.org",
    /** Shown as link text; the scheme is noise on screen. */
    websiteLabel: "broadmate.org",

    /**
     * How to reach a human.
     *
     * On the public page, in the structured data, and behind the WhatsApp
     * button. One place, because a phone number that is right in two of three
     * is worse than one nobody can find.
     */
    email: "support@broadmate.org",
    /** Display form. */
    phone: "+91 96080 60350",
    /** Dialable and E.164, for `tel:` and wa.me — no spaces, no plus for wa.me. */
    phoneE164: "+919608060350",
    whatsappNumber: "919608060350",
  },
} as const;

/**
 * A WhatsApp enquiry that starts as a sentence.
 *
 * A blank chat window makes somebody compose an opening line before they have
 * asked their question, which is the moment most of them close it.
 */
export const WHATSAPP_ENQUIRY = `https://wa.me/${BRAND.maker.whatsappNumber}?text=${encodeURIComponent(
  `Hi ${BRAND.maker.name}, I would like to know more about ${BRAND.name} for my company.`,
)}`;

/** One-line credit for PDF footers and the app shell. */
export const MADE_BY = `${BRAND.maker.credit} · ${BRAND.maker.websiteLabel}`;
