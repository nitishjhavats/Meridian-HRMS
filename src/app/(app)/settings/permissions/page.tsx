import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { listManageableUsers, listUserPermissions } from "@/services/org/permissions";
import { PageHeader } from "@/components/ui/stat";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { PermissionManager } from "./PermissionManager";

export const metadata = { title: "Individual permissions" };
export const dynamic = "force-dynamic";

/**
 * Give one person something their role does not include, or take it away.
 *
 * The person is in the query string rather than in client state, so a link to
 * "the permissions of this employee" is a link somebody can send, and so a save
 * followed by `router.refresh()` comes back to the same person with fresh
 * figures rather than resetting to the top of the list.
 */
export default async function PermissionsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string }>;
}) {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "org.settings.write",
    what: "individual permissions",
  });
  if (denied) return denied;

  const params = await searchParams;
  // Not a `Promise.all`: which person may be loaded depends on which people this
  // caller may load at all, and the picker is what answers that. A `?user=` that
  // is not in the list is ignored rather than refused — a stale link should land
  // somewhere useful, and the service refuses again underneath regardless.
  const picker = await listManageableUsers(ctx);
  const selected = picker.users.find((u) => u.id === params.user) ?? picker.users[0] ?? null;
  const view = selected ? await listUserPermissions(ctx, selected.id) : null;

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
        title="Individual permissions"
        description="A role is a starting point, not a straitjacket. Give one person something their role does not include, or take something away — for them alone, and only ever from what you hold yourself."
      />

      {view ? (
        <PermissionManager
          users={picker.users}
          restricted={picker.restricted}
          view={view}
          actorRoleLabel={ROLE_LABELS[ctx.role]}
        />
      ) : (
        <EmptyState
          icon={ShieldCheck}
          title="There is nobody here you can adjust"
          description={
            picker.restricted > 0
              ? `${picker.restricted === 1 ? "The one other login" : `All ${picker.restricted} other logins`} in this organisation ${picker.restricted === 1 ? "is" : "are"} out of your reach: your own account, anybody at or above your own role, and office devices. Somebody more senior can make changes there.`
              : "Nobody else has a login yet. Add people to the employee directory first, and they will appear here."
          }
          action={
            <Button asChild variant="secondary">
              <Link href="/employees">Open the employee directory</Link>
            </Button>
          }
        />
      )}
    </>
  );
}
