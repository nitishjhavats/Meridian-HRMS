import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listBalances } from "@/services/leave/balances";
import { PageHeader } from "@/components/ui/stat";
import { LeaveBalances } from "./LeaveBalances";
import { DesignationAllocations } from "./DesignationAllocations";

export const metadata = { title: "Leave balances" };
export const dynamic = "force-dynamic";

/**
 * Opening balances, corrections, and the year-end run.
 *
 * `leave.balance.manage` was declared when the permission list was written and
 * has gated nothing since, because there was nowhere to manage a balance: the
 * approval path could only ever add to `used`, and the domain's
 * `carryForwardAmount` was called by nothing at all. So an organisation's
 * unused days quietly lapsed on the 31st of December and a mistaken balance
 * could only be fixed in the database.
 *
 * Guarded on the manage permission rather than a read one. There is nothing to
 * learn here that is not already on the employee's own leave screen — this page
 * exists to change things, and a visitor who cannot change them would be handed
 * a grid of buttons that all refuse.
 */
export default async function LeaveBalancesPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "leave.balance.manage",
    module: "leave",
    what: "leave balances",
  });
  if (denied) return denied;

  const grid = await listBalances(ctx, {});

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
        title="Leave balances"
        description="What everybody is entitled to this year, corrections to it, and the run that carries unused days into the next year."
      />

      <LeaveBalances initial={grid} />

      {/* Below the grid, because it is the layer above it: this sets what a
          role gets, and the rows above override one person against it. */}
      <DesignationAllocations canWrite={ctx.permissions.has("leave.balance.manage")} />
    </>
  );
}
