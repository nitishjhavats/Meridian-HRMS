import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { getSalaryComponents } from "@/services/payroll/salaryStructure";
import { PageHeader } from "@/components/ui/stat";
import { SalaryStructure } from "./SalaryStructure";

export const metadata = { title: "Salary structure" };
export const dynamic = "force-dynamic";

/**
 * The components pay is built from.
 *
 * `salary.structure.manage` has been declared and granted to Admins since the
 * permission list was written and gated nothing, because this screen did not
 * exist. The only way a component ever changed was through the AI rule builder,
 * and the only check on the result — `validateSalaryStructure` — was called from
 * no write path at all.
 *
 * Guarded on the manage permission rather than a read one: there is nothing to
 * understand here without changing something. What an individual is paid is on
 * their own profile, and what a month paid is on the payslip.
 */
export default async function SalaryStructurePage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "salary.structure.manage",
    module: "payroll",
    what: "the salary structure",
  });
  if (denied) return denied;

  const snapshot = await getSalaryComponents(ctx);

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
        title="Salary structure"
        description="The components every salary is divided into, and how each one is calculated. Try a CTC against them before you save — a structure that is wrong is otherwise discovered on payday."
      />

      <SalaryStructure
        initial={snapshot}
        canPublish={ctx.permissions.has("payroll.rules.manage")}
      />
    </>
  );
}
