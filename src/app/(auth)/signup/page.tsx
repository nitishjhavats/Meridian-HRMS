import Link from "next/link";
import { redirect } from "next/navigation";
import { optionalContext } from "@/lib/auth/context";
import { landingFor } from "@/lib/auth/landing";
import { prisma } from "@/lib/db/prisma";
import { Alert } from "@/components/ui/states";
import { BRAND } from "@/lib/brand";
import { SignUpForm } from "./SignUpForm";

export const metadata = { title: "Create your organisation" };
export const dynamic = "force-dynamic";

export default async function SignUpPage() {
  const ctx = await optionalContext();
  if (ctx) redirect(landingFor(ctx.role));

  const settings = await prisma.platformSetting.findUnique({
    where: { id: "singleton" },
    select: { selfSignupEnabled: true, defaultTrialDays: true },
  });

  // The switch is read here as well as in the route: with sign-up closed the
  // right thing is a page explaining that, not a form that fails on submit.
  // Matches the service: no settings row means closed, not open.
  if (!(settings?.selfSignupEnabled ?? false)) {
    return (
      <>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Sign-up is by invitation</h1>
        </div>
        <Alert tone="info" title="New organisations are being set up manually right now">
          Get in touch and we will create your organisation for you —{" "}
          <a
            href={`mailto:${BRAND.maker.email}`}
            className="font-medium underline underline-offset-2"
          >
            {BRAND.maker.email}
          </a>{" "}
          or{" "}
          <a href={`tel:${BRAND.maker.phoneE164}`} className="font-medium underline underline-offset-2">
            {BRAND.maker.phone}
          </a>
          .
        </Alert>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Create your organisation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          You become the Owner. Everything is set up ready to use — shifts, leave types, salary
          components and payroll rules all start from sensible defaults.
        </p>
      </div>
      <SignUpForm trialDays={settings?.defaultTrialDays ?? 14} />

      {/* Said here rather than discovered at 11pm.

          This product sends no email, by design: password resets are released
          by a person and handed over directly. That was unremarkable while
          Broadmate created every organisation by hand — they were already in
          the loop. Somebody signing themselves up at midnight is not, and the
          honest thing is to say so before they choose a password, not after
          they have forgotten it. */}
      <div className="mt-6">
        <Alert tone="info" title="Keep your password somewhere safe">
          We do not send email. If the owner&rsquo;s password is lost, recovery goes through{" "}
          <a
            href={`mailto:${BRAND.maker.email}`}
            className="font-medium underline underline-offset-2"
          >
            {BRAND.maker.email}
          </a>{" "}
          or{" "}
          <a href={`tel:${BRAND.maker.phoneE164}`} className="font-medium underline underline-offset-2">
            {BRAND.maker.phone}
          </a>{" "}
          — a person releases a code and gives it to you. Everyone else you add can be reset by
          you, from their profile.
        </Alert>
      </div>
    </>
  );
}
