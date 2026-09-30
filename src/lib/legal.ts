import { BRAND } from "./brand";

/**
 * The legal documents, and the one fact every part of the product needs from
 * them: which version somebody agreed to.
 *
 * A date rather than a number, because the question anybody ever asks is "what
 * did the terms say when they signed up", and a date answers it directly
 * against the git history of these pages.
 *
 * Bump it whenever the substance of a policy changes — not for a typo. Existing
 * users keep the version they accepted, which is what makes the record worth
 * having.
 */
/**
 * Must stay parseable by `new Date()`: `sitemap.ts` uses it as `lastModified`,
 * and a suffix like "-chat" makes it an Invalid Date, which fails the build
 * during prerender rather than at review. A time is fine when the substance
 * changes twice in a day.
 */
export const LEGAL_VERSION = "2026-09-08T10:00:00.000Z";

export const LEGAL_PAGES = [
  { href: "/legal/privacy", title: "Privacy policy" },
  { href: "/legal/terms", title: "Terms of service" },
  { href: "/legal/cookies", title: "Cookie policy" },
  { href: "/legal/refunds", title: "Refund policy" },
] as const;

/**
 * Who to contact, and about what.
 *
 * The SPDI Rules require a named grievance contact published on the site, and
 * the DPDP Act wants a contact for data-protection questions. Until Broadmate
 * has a registered address and a named officer to publish, this is the most
 * that can be said truthfully: a role, and a route to a human.
 */
export const LEGAL_CONTACT = {
  email: BRAND.maker.email,
  phone: BRAND.maker.phone,
  phoneE164: BRAND.maker.phoneE164,
  grievanceRole: "Grievance Officer",
} as const;
