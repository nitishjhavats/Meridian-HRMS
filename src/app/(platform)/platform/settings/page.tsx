import { requirePageContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { getSettings } from "@/services/platform/settings";
import { PageHeader, Section } from "@/components/ui/stat";
import { LogoUploader } from "@/components/brand/LogoUploader";
import { SettingsForm } from "./SettingsForm";

export const metadata = { title: "Platform settings" };
export const dynamic = "force-dynamic";

export default async function PlatformSettingsPage() {
  const ctx = await requirePageContext({ superadmin: true });
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.settings.manage");

  const settings = await getSettings();

  return (
    <>
      <PageHeader
        title="Platform settings"
        description="Pricing, payment collection and platform-wide policy. No price is hard-coded anywhere else."
      />
      <Section
        title="Platform logo"
        description="Replaces the built-in mark on the sign-in screen and becomes the installed app's icon. An organisation's own logo takes precedence over this one inside their workspace."
      >
        <div className="p-4">
          <LogoUploader
            endpoint="/api/platform/settings/logo"
            currentLogoUrl={settings.logoKey ? "/api/branding/platform-logo" : null}
            label="Platform"
            hint="Used wherever no organisation logo applies."
          />
        </div>
      </Section>

      <Section title="Configuration">
        <SettingsForm settings={settings} />
      </Section>
    </>
  );
}
