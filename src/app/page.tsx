import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CalendarDays,
  Clock,
  Fingerprint,
  ReceiptIndianRupee,
  ScrollText,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { optionalContext } from "@/lib/auth/context";
import { resolveBranding } from "@/lib/branding";
import { prisma } from "@/lib/db/prisma";
import { BRAND, WHATSAPP_ENQUIRY } from "@/lib/brand";
import { LEGAL_PAGES } from "@/lib/legal";
import { WhatsAppButton } from "@/components/landing/WhatsAppButton";
import { BrandMark } from "@/components/brand/BrandMark";
import { MakerCredit } from "@/components/brand/MakerCredit";
import { Button } from "@/components/ui/button";
import { CheckInMock, LandingKeyframes, LoopDiagram } from "@/components/landing/LandingArt";

/**
 * The front door.
 *
 * This used to be a nine-line redirect to `/login`, which meant the first thing
 * anybody saw was a demand for credentials with nothing around it explaining
 * whose credentials, or for what. An employee opening a link from their HR team
 * deserves to recognise where they have landed before they are asked to prove
 * who they are.
 *
 * Employees come first, because almost everyone arriving here is one. New
 * organisations are onboarded by Broadmate Global rather than signing themselves
 * up, so there is a way to get in touch and no form pretending otherwise.
 *
 * Signed in, it still routes straight through — nobody who is already
 * authenticated should have to look at marketing.
 */
export const dynamic = "force-dynamic";

/** Trailing slashes off APP_URL, so the canonical link has exactly one. */
const TRAILING_SLASH = /\/+$/;

const FEATURES = [
  {
    icon: Clock,
    title: "Check in where the work is",
    body: "Inside your own radius, on your own shift. The time recorded is the server's, never the phone's.",
  },
  {
    icon: ReceiptIndianRupee,
    title: "Payslips that show their working",
    body: "Every rupee traceable to the rule that produced it, and downloadable as a PDF.",
  },
  {
    icon: CalendarDays,
    title: "Leave without the chasing",
    body: "Apply, watch it move through the approval chain, and see the balance it leaves behind.",
  },
] as const;

const ASSURANCES = [
  {
    icon: Fingerprint,
    title: "Face verification stays here",
    body: "Matching runs on this server. Photos are not sent to any third party.",
  },
  {
    icon: ShieldCheck,
    title: "Isolated and audited",
    body: "Each organisation's data is separate, and changes are written to an audit log.",
  },
  {
    icon: Smartphone,
    title: "Installs like an app",
    body: "Add it to a home screen for a one-tap check-in, leave request or payslip.",
  },
  {
    icon: ScrollText,
    title: "Documents and letters",
    body: "A vault with versions, and official letters issued as PDFs.",
  },
] as const;

export default async function HomePage() {
  const ctx = await optionalContext();
  if (ctx) redirect(ctx.isSuperadmin ? "/platform" : "/dashboard");

  const branding = await resolveBranding();
  const organizationName = branding.organization?.name ?? null;

  /**
   * The commercial facts, read rather than written into the page.
   *
   * A price typed into marketing copy and the price the billing quote uses are
   * two numbers that will disagree within a quarter. This is the same column
   * `billing/quote` reads. Wrapped because the page must render with the
   * database unreachable — the same reason `resolveBranding` catches — and half
   * a landing page is better than a 500.
   */
  const settings = await prisma.platformSetting
    .findUnique({
      where: { id: "singleton" },
      select: { selfSignupEnabled: true, pricePerUserPaise: true, defaultTrialDays: true },
    })
    .catch(() => null);

  const signupOpen = settings?.selfSignupEnabled ?? false;
  const pricePerUser = Math.round((settings?.pricePerUserPaise ?? 5900) / 100);
  const trialDays = settings?.defaultTrialDays ?? 14;

  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(TRAILING_SLASH, "");
  /**
   * Structured data, so a search result says what this is rather than guessing.
   *
   * `application/ld+json` is data, not executed script, so `script-src` is not
   * involved — which is the only reason this is possible under a CSP that
   * permits no external scripts at all.
   */
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: BRAND.name,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web, Android, iOS",
    description:
      "HR, attendance, leave and payroll software for Indian companies. GPS and face-verified check-in, leave with an approval chain, and payroll that shows its working.",
    url: appUrl + "/",
    offers: {
      "@type": "Offer",
      price: String(pricePerUser),
      priceCurrency: "INR",
      description:
        "Per employee per month" + (trialDays > 0 ? ", after a " + trialDays + "-day free trial" : ""),
    },
    publisher: {
      "@type": "Organization",
      name: BRAND.maker.name,
      url: BRAND.maker.website,
      contactPoint: {
        "@type": "ContactPoint",
        contactType: "sales",
        email: BRAND.maker.email,
        telephone: BRAND.maker.phoneE164,
        areaServed: "IN",
        // English only. This said `["en", "hi"]`, which is a factual claim
      // published as structured data — and there is no Hindi string and no i18n
      // layer anywhere in the product.
      availableLanguage: ["en"],
      },
    },
  };

  return (
    <>
      <LandingKeyframes />

      {/* Data, not script. See the note beside `jsonLd` above. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className="relative min-h-dvh overflow-hidden bg-background">
        {/* One soft field behind the fold, so the hero sits on a surface rather
            than on a flat slab of --background. Pointer-events off; it is
            decoration and must never eat a click on the sign-in button. */}
        <div
          aria-hidden
          className="lp-drift pointer-events-none absolute -top-40 left-1/2 -z-10 size-[46rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl"
        />

        <header className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-5 sm:gap-4 sm:px-8">
          {/**
            * The front door says its own name loudly, and the credit under it
            * once.
            *
            * The second line is normally "HRMS by Broadmate Global", which is
            * right on a tenant's screen where the top line is their company.
            * Here the top line is already HRMS, so the full string repeated
            * the product's name and then broke over three lines on a phone:
            * "HRMS by / Broadmate / Global". The credit alone says the same
            * thing in one line and 102px.
            */}
          <BrandMark branding={branding} size="lg" subtitle={branding.maker.credit} />
          {/* Both doors, always. When sign-up is closed `/signup` explains that it
              is by invitation and offers email, phone and WhatsApp -- which is a
              better answer than the button vanishing, because a vanished button
              reads as "there is no way in".

              The wording shortens rather than the button disappearing: "Create
              an organisation" is 150px of a 375px row, and on a phone the hero
              below says the same thing at full length on its own button. */}
          <div className="flex shrink-0 items-center gap-2">
            {/* Hidden below 360px, and only there. On a 320px screen the credit
                under HRMS needs those ninety pixels to stay on one line, and
                this button is the one thing in the row that is said again two
                hundred pixels down the page -- "Start a 14-day free trial" is
                in the same viewport without scrolling. Both doors are still
                open; one of them is just further down the wall. */}
            <Button asChild size="sm" variant="ghost" className="max-[359px]:hidden">
              <Link href="/signup">
                <span className="sm:hidden">Sign up</span>
                <span className="hidden sm:inline">Create an organisation</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </header>

        <main id="main">
          {/* ------------------------------ hero ------------------------------ */}
          {/* The hero fills the first desktop screen. Without a minimum height it is
              content-sized, and at 1440x900 the header is 82px while the hero is
              short enough that the loop section below rises into the fold and shows
              a slice of itself. `dvh` rather than `vh` so a mobile browser chrome
              that hides on scroll does not leave a gap. */}
          <section className="mx-auto max-w-6xl px-5 pb-16 pt-6 sm:px-8 lg:grid lg:min-h-[calc(100dvh-5.25rem)] lg:grid-cols-2 lg:items-center lg:gap-16 lg:pb-24 lg:pt-12">
            <div className="max-w-xl">
              {/* `text-balance` rather than a manual <br>: the organisation's name
                  is arbitrary length, and a hard break that reads well for
                  "Acme" leaves an orphan for "Bright Retail Private Limited". */}
              <h1 className="lp-rise text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
                {organizationName
                  ? `Attendance, leave and pay for ${organizationName}.`
                  : "Attendance, leave and pay. In one place."}
              </h1>

              <p
                className="lp-rise mt-4 text-lg text-muted-foreground"
                style={{ animationDelay: ".08s" }}
              >
                Check in from where you work. See what you earned, and why.
              </p>

              <div
                className="lp-rise mt-7 flex flex-wrap items-center gap-3"
                style={{ animationDelay: ".16s" }}
              >
                {signupOpen ? (
                  <>
                    <Button asChild size="lg">
                      <Link href="/signup">
                        Start {trialDays > 0 ? `a ${trialDays}-day` : "a"} free trial
                      </Link>
                    </Button>
                    <Button asChild variant="ghost" size="lg">
                      <Link href="/login">Sign in</Link>
                    </Button>
                  </>
                ) : (
                  <>
                    <Button asChild size="lg">
                      <Link href="/login">Sign in</Link>
                    </Button>
                    {/* Not "forgotten your password?" -- that belongs under the
                        password field, where somebody who has forgotten one
                        actually is, rather than as one of two things a stranger
                        is invited to do on a marketing page. */}
                    <Button asChild variant="ghost" size="lg">
                      <Link href="/signup">Create an organisation</Link>
                    </Button>
                  </>
                )}
              </div>

              <p
                className="lp-rise mt-4 text-sm text-muted-foreground"
                style={{ animationDelay: ".24s" }}
              >
                {signupOpen
                  ? [
                      "No card.",
                      pricePerUser > 0 ? `₹${pricePerUser} per employee per month after that.` : "",
                      "Already set up? Use the work email your organisation registered for you.",
                    ]
                      .filter(Boolean)
                      .join(" ")
                  : "Use the work email your organisation registered for you."}
              </p>
            </div>

            <div className="mt-14 lg:mt-0">
              <CheckInMock organizationName={organizationName} />
            </div>
          </section>

          {/* ---------------------------- the loop ---------------------------- */}
          <section className="border-y border-border bg-card/40">
            <div className="mx-auto max-w-3xl px-5 py-14 sm:px-8">
              <LoopDiagram
                steps={["You check in", "The day is scored", "The month becomes a payslip"]}
              />
            </div>
          </section>

          {/* ---------------------------- features ---------------------------- */}
          <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
            {/* A heading rather than three unlabelled cards. It reads better,
                and it is what a search engine has to go on. */}
            <h2 className="mb-8 max-w-2xl text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
              Attendance, leave and payroll, without the chasing
            </h2>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-3">
              {FEATURES.map((feature, i) => (
                <div
                  key={feature.title}
                  className="lp-rise rounded-xl border border-border bg-card p-6"
                  style={{ animationDelay: `${i * 0.1}s` }}
                >
                  <span className="grid size-11 place-items-center rounded-lg bg-primary-muted text-primary">
                    <feature.icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-base font-semibold">{feature.title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{feature.body}</p>
                </div>
              ))}
            </div>
          </section>

          {/* --------------------------- assurances --------------------------- */}
          <section className="border-t border-border bg-card/40">
            <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
              <ul className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-7 sm:grid-cols-2 lg:grid-cols-4">
                {ASSURANCES.map((item) => (
                  <li key={item.title}>
                    <item.icon className="size-5 text-primary" aria-hidden />
                    <h3 className="mt-2.5 text-sm font-medium">{item.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* -------------------------- organisations ------------------------- */}
          <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
            <div className="rounded-xl border border-border bg-card p-7 sm:flex sm:items-center sm:justify-between sm:gap-8">
              <div className="max-w-lg">
                <h2 className="text-lg font-semibold">
                  Want this for your organisation?
                </h2>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {signupOpen
                    ? [
                        trialDays > 0
                          ? `Start free for ${trialDays} days and set it up yourself`
                          : "Set it up yourself",
                        "— departments, shifts, leave types and payroll rules.",
                        pricePerUser > 0 ? `₹${pricePerUser} per employee per month.` : "",
                        "Or ask us and we will do it with you.",
                      ]
                        .filter(Boolean)
                        .join(" ")
                    : `${branding.maker.name} sets each one up — your departments, shifts, leave types and payroll rules — and hands your administrator the keys.`}
                </p>
                <ul className="mt-4 space-y-1.5 text-sm">
                  <li>
                    <a
                      href={`mailto:${BRAND.maker.email}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {BRAND.maker.email}
                    </a>
                  </li>
                  <li>
                    <a
                      href={`tel:${BRAND.maker.phoneE164}`}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {BRAND.maker.phone}
                    </a>
                  </li>
                </ul>
              </div>
              <div className="mt-5 flex flex-wrap gap-2 sm:mt-0">
                {signupOpen ? (
                  <Button asChild>
                    <Link href="/signup">Start free</Link>
                  </Button>
                ) : null}
                <Button asChild variant="secondary">
                  <a href={WHATSAPP_ENQUIRY} target="_blank" rel="noreferrer noopener">
                    WhatsApp us
                  </a>
                </Button>
              </div>
            </div>
          </section>
        </main>

        <footer className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-7 text-xs text-muted-foreground sm:px-8">
            <BrandMark branding={branding} size="sm" />
            <nav aria-label="Legal" className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {LEGAL_PAGES.map((page) => (
                <Link
                  key={page.href}
                  href={page.href}
                  className="underline-offset-4 hover:text-foreground hover:underline"
                >
                  {page.title}
                </Link>
              ))}
            </nav>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <a
                href={`mailto:${BRAND.maker.email}`}
                className="underline-offset-4 hover:text-foreground hover:underline"
              >
                {BRAND.maker.email}
              </a>
              <a
                href={`tel:${BRAND.maker.phoneE164}`}
                className="underline-offset-4 hover:text-foreground hover:underline"
              >
                {BRAND.maker.phone}
              </a>
            </span>
            <MakerCredit logoUrl={branding.platformLogoUrl} />
          </div>
        </footer>

        {/* Public pages only — see the note in the component. */}
        <WhatsAppButton />
      </div>
    </>
  );
}
