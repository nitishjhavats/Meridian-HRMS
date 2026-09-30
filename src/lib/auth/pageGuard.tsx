import Link from "next/link";
import { Lock, PackageOpen, UserRoundX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { getModule, type ModuleKey } from "../features";
import type { AuthContext } from "./context";
import type { Permission } from "./permissions";

/**
 * Page-level access checks.
 *
 * The API guards throw, because a refused request is an error. A refused *page*
 * is not — it is a normal thing to land on after following a stale link or
 * having a role changed, and it deserves a designed screen rather than the
 * framework's crash page. So this returns something to render instead.
 *
 * It is not the security boundary. Every route these pages call still enforces
 * the same permission itself; this only decides what the person sees.
 */

export interface PageGuardChecks {
  permission?: Permission;
  /** Any one of these is enough. */
  anyPermission?: Permission[];
  module?: ModuleKey;
  superadmin?: boolean;
  /**
   * The page is about the signed-in person's own record, so it needs one.
   *
   * A login is not always an employee: the Superadmin never is, and the owner
   * of a newly created organisation is not one either until somebody adds them.
   * Those pages used to reach a service that threw, and the generic error
   * boundary is a poor way to say "you have no employee record".
   */
  ownEmployeeRecord?: boolean;
  /** Named in the message: "permission to view …". */
  what?: string;
}

export function pageGuard(ctx: AuthContext, checks: PageGuardChecks): React.ReactElement | null {
  const what = checks.what ?? "this page";

  if (checks.superadmin && !ctx.isSuperadmin) {
    return (
      <EmptyState
        icon={Lock}
        title="Platform owners only"
        description="This area belongs to the platform owner, not to an organisation."
        action={
          <Button asChild variant="secondary">
            <Link href="/dashboard">Back to the dashboard</Link>
          </Button>
        }
      />
    );
  }

  const permissions = checks.anyPermission ?? (checks.permission ? [checks.permission] : []);
  if (permissions.length > 0 && !permissions.some((p) => ctx.permissions.has(p))) {
    return (
      <EmptyState
        icon={Lock}
        title="You do not have access"
        description={`Your role does not include permission to view ${what}. Ask an administrator if you think this is wrong.`}
        action={
          <Button asChild variant="secondary">
            <Link href="/dashboard">Back to the dashboard</Link>
          </Button>
        }
      />
    );
  }

  if (checks.ownEmployeeRecord && !ctx.employeeId) {
    const canFix = ctx.permissions.has("employee.create");
    return (
      <EmptyState
        icon={UserRoundX}
        title="Your login is not linked to an employee record"
        description={
          canFix
            ? `${what.charAt(0).toUpperCase()}${what.slice(1)} belongs to an employee, and this login is not one yet. Add yourself to the employee directory and it will appear here.`
            : `${what.charAt(0).toUpperCase()}${what.slice(1)} belongs to an employee, and this login is not one yet. Ask an administrator to add you to the employee directory.`
        }
        action={
          <Button asChild variant="secondary">
            <Link href={canFix ? "/employees" : "/dashboard"}>
              {canFix ? "Open the employee directory" : "Back to the dashboard"}
            </Link>
          </Button>
        }
      />
    );
  }

  if (checks.module && !ctx.modules.has(checks.module)) {
    const name = getModule(checks.module)?.name ?? checks.module;
    // Only an admin can act on this, so only an admin is offered the link.
    const canFix = ctx.permissions.has("org.modules.manage");
    return (
      <EmptyState
        icon={PackageOpen}
        title={`${name} is switched off`}
        description={
          canFix
            ? `Your organisation is not using ${name} at the moment. You can switch it back on in settings.`
            : `Your organisation is not using ${name} at the moment. An administrator can switch it on.`
        }
        action={
          canFix ? (
            <Button asChild variant="secondary">
              <Link href="/settings/modules">Open module settings</Link>
            </Button>
          ) : (
            <Button asChild variant="secondary">
              <Link href="/dashboard">Back to the dashboard</Link>
            </Button>
          )
        }
      />
    );
  }

  return null;
}
