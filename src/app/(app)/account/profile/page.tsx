import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { PageHeader, Section } from "@/components/ui/stat";
import { getMyProfile } from "@/services/account/profile";
import { ProfileForm } from "./ProfileForm";

export const metadata = { title: "Your profile" };
export const dynamic = "force-dynamic";

/**
 * The one pair of facts a letter falls back to.
 *
 * Gated, unlike `/account/security` beside it, and for a reason worth stating:
 * security shows you your own sessions, which everybody has an equal right to.
 * This changes a name that prints on a payslip and a designation that decides
 * who approves somebody's leave. That belongs to the people who already hold
 * `org.settings.write`, and everybody else's stays HR's to set.
 */
export default async function ProfilePage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "org.settings.write",
    what: "your signing name and designation",
  });
  if (denied) return denied;

  const profile = await getMyProfile(ctx);

  return (
    <>
      <PageHeader
        title="Your profile"
        description="What letters you issue are signed with, when the letter type has no signatory of its own."
      />

      <Section
        title="Signing details"
        description="A letter type can override these. Leave that blank and it falls back to here."
      >
        <ProfileForm initial={profile} />
      </Section>
    </>
  );
}
