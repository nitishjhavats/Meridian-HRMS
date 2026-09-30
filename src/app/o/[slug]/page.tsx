import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { optionalContext } from "@/lib/auth/context";
import { landingFor } from "@/lib/auth/landing";
import { brandingForSlug } from "@/lib/branding";
import { BRAND } from "@/lib/brand";
import { LoginForm } from "../../(auth)/login/LoginForm";
import { SignOutHere } from "./SignOutHere";

export const dynamic = "force-dynamic";

/**
 * The link an administrator hands to their people.
 *
 * Signed in already, it is a pass-through to their own dashboard — which is
 * what makes this a URL somebody can bookmark rather than a page they have to
 * get past. If the slug is not theirs, they are told plainly rather than shown
 * somebody else's door with their own session behind it.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const branding = await brandingForSlug(slug);
  const title = branding.organization ? `${branding.organization.name} — Sign in` : "Sign in";
  return {
    title,
    // Each tenant door gets its own manifest, so installing from here gives
    // their name and their icon rather than the product's.
    manifest: `/o/${slug}/manifest.webmanifest`,
  };
}

export default async function TenantLoginPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [ctx, branding] = await Promise.all([optionalContext(), brandingForSlug(slug)]);
  const organization = branding.organization;

  if (ctx) {
    /**
     * Their own organisation, or the platform owner: straight through.
     *
     * Compared by id rather than against the slug in the URL. An address an
     * organisation has left behind still resolves to it, and a member arriving
     * on one of those was told they were "signed in somewhere else" -- at their
     * own company.
     */
    if (!organization || ctx.isSuperadmin || ctx.organization?.id === organization.id) {
      redirect(landingFor(ctx.role));
    }

    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          You are signed in somewhere else
        </h1>
        <p className="text-sm text-muted-foreground">
          This is {organization.name}&rsquo;s sign-in page, and you are signed in as{" "}
          <span className="font-medium text-foreground">{ctx.email}</span> at{" "}
          {ctx.organization?.name ?? "another organisation"}. Sign out first if you meant to use a
          different account.
        </p>
        {/* The instruction and the means to follow it, side by side. The
            screen used to say "sign out first" and offer only the dashboard,
            which is the one place the sign-out is not. */}
        {/* A kiosk device that reaches this screen is a reception tablet
            somebody opened their own company's door on. One tap here would
            sign the tablet out for everybody until an administrator types
            the device password again -- so the tablet gets a sentence, and
            the person gets told to use their own phone. */}
        <div className="flex flex-wrap items-center gap-4">
          {ctx.role === "KIOSK" ? (
            <p className="text-sm text-muted-foreground">
              This is a shared attendance device. Sign in on your own phone instead.
            </p>
          ) : (
            <SignOutHere slug={slug} />
          )}
          <a
            href="/dashboard"
            className="inline-block text-sm text-primary underline-offset-4 hover:underline"
          >
            Go to your own dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {organization ? `Sign in to ${organization.name}` : "Sign in"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {organization
            ? `Use the work email ${organization.name} registered for you.`
            : `Use the work email your organisation registered for you. ${BRAND.name} is by ${BRAND.maker.name}.`}
        </p>
      </div>
      <LoginForm tenant={organization ? { id: organization.id, slug } : null} />
    </>
  );
}
