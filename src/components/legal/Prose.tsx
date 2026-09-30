import { LEGAL_VERSION } from "@/lib/legal";

/**
 * The shared furniture of a legal page.
 *
 * There is no typography plugin in this project — Tailwind v4 CSS-first, no
 * `@tailwindcss/typography` — so the prose styles are declared once here rather
 * than being retyped down four documents and drifting apart.
 *
 * Deliberately plain. A privacy policy set in the same restrained type as the
 * rest of the product reads as something written to be understood; one dressed
 * up reads as something written to be scrolled past.
 */

export function LegalHeader({ title, summary }: { title: string; summary: string }) {
  return (
    <header className="mb-8">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-base text-muted-foreground">{summary}</p>
      <p className="mt-4 text-xs text-muted-foreground">
        Version {LEGAL_VERSION}. We will say here when this changes.
      </p>
    </header>
  );
}

export function Section({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 scroll-mt-20" id={id}>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-foreground/90">{children}</div>
    </section>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p>{children}</p>;
}

export function List({ children }: { children: React.ReactNode }) {
  return <ul className="ml-5 list-disc space-y-1.5">{children}</ul>;
}

/**
 * A table of what is held and why.
 *
 * Scrolls inside itself on a narrow screen rather than pushing the page
 * sideways, which is the one layout rule a long document has to get right on a
 * phone.
 */
export function Facts({
  head,
  rows,
}: {
  head: readonly string[];
  rows: readonly (readonly React.ReactNode[])[];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-muted/50">
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="px-3 py-2 text-left text-xs font-medium text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A point the reader should not skim past. */
export function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-4">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-1.5 space-y-2 text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
