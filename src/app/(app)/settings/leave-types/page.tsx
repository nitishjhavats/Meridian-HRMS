import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { PageHeader } from "@/components/ui/stat";
import { LeaveTypes } from "./LeaveTypes";

export const metadata = { title: "Leave types" };
export const dynamic = "force-dynamic";

/**
 * The leave types an organisation offers.
 *
 * `leave.type.manage` was declared with the permission list and gated nothing,
 * because nothing wrote a `LeaveType` after provisioning. Five were seeded and
 * that was the organisation's leave policy for ever.
 */
export default async function LeaveTypesPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "leave.type.manage",
    module: "leave",
    what: "leave types",
  });
  if (denied) return denied;

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
        title="Leave types"
        description="Casual, sick, earned, unpaid — how many days each gives, whether it is paid, and how it accrues."
      />

      <LeaveTypes canWrite={ctx.permissions.has("leave.type.manage")} />
    </>
  );
}
