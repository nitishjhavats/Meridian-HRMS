import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { organizationBranding } from "@/lib/branding";
import { getOrganizationProfile } from "@/services/org/profile";
import { PageHeader, Section } from "@/components/ui/stat";
import { LogoUploader } from "@/components/brand/LogoUploader";
import { OrganisationProfile } from "./Profile";
import { Structure } from "./Structure";
import { RenumberCodes } from "./RenumberCodes";
import { ReportingLines } from "./ReportingLines";

export const metadata = { title: "Organisation" };
export const dynamic = "force-dynamic";

export default async function OrganisationSettingsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "org.settings.write",
    what: "organisation settings",
  });
  if (denied) return denied;

  const [branding, profile] = await Promise.all([
    organizationBranding(ctx.organizationId),
    getOrganizationProfile(ctx),
  ]);

  return (
    <>
      <Link
        href="/settings"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Settings
      </Link>

      <PageHeader
        title="Organisation"
        description={`How ${branding?.name ?? "your organisation"} appears to the people who use it.`}
      />

      <Section
        title="Logo"
        description="Shown beside your name in the app, on the sign-in screen, and as the icon when someone installs it on their phone."
      >
        <div className="p-4">
          <LogoUploader
            endpoint="/api/settings/organisation/logo"
            currentLogoUrl={branding?.logoUrl ?? null}
            label={branding?.name ?? "Your organisation"}
            hint="Replaces the letter mark everywhere it appears."
          />
        </div>
      </Section>

      <div className="mt-4">
        <OrganisationProfile initial={profile} />
      </div>

      {ctx.permissions.has("employee.update") ? (
        <div className="mt-4">
          <RenumberCodes prefix={profile.employeeCodePrefix} />
        </div>
      ) : null}

      <div className="mt-4">
        <Structure canWrite={ctx.permissions.has("org.structure.manage")} />
      </div>

      <div className="mt-4">
        <ReportingLines canWrite={ctx.permissions.has("org.structure.manage")} />
      </div>
    </>
  );
}
