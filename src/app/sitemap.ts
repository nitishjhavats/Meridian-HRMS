import type { MetadataRoute } from "next";
import { LEGAL_PAGES, LEGAL_VERSION } from "@/lib/legal";

/**
 * What a search engine should know about.
 *
 * Exactly one page. Everything else on this instance is either behind a login
 * or is a named customer's door at `/o/<slug>`, and listing those would publish
 * which companies Broadmate serves.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  const parsed = new Date(LEGAL_VERSION);
  const legalDate = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return [
    {
      url: `${base}/`,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    // The legal pages are public on purpose: a policy nobody can find is not a
    // policy, and payment gateways and search engines both expect them at a
    // stable URL.
    ...LEGAL_PAGES.map((page) => ({
      url: `${base}${page.href}`,
      // Tolerant on purpose. `LEGAL_VERSION` is a human-edited string, and an
      // unparseable one used to fail the *build* at prerender -- a policy typo
      // taking the whole deploy down.
      lastModified: legalDate,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    })),
  ];
}
