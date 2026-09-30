import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listAdvances } from "@/services/payroll/advances";
import { listEmployees } from "@/services/employees";
import { PageHeader } from "@/components/ui/stat";
import { AdvanceList } from "./AdvanceList";

export const metadata = { title: "Advances" };
export const dynamic = "force-dynamic";

/**
 * The screen behind a navigation link that has 404ed since the link existed.
 *
 * Both lists are fetched here rather than in the client, following the shape the
 * rest of the product uses: the employee list is only needed by somebody who can
 * issue, and this page already refuses anybody who cannot.
 */
export default async function AdvancesPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "advance.manage",
    module: "payroll",
    what: "salary advances",
  });
  if (denied) return denied;

  const [advances, employees] = await Promise.all([
    listAdvances(ctx),
    listEmployees(ctx, {}),
  ]);

  return (
    <>
      <Link
        href="/payroll"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Payroll
      </Link>

      <PageHeader
        title="Salary advances"
        description="Money paid ahead of payroll, and what is still owed."
      />

      <AdvanceList
        initial={advances.map((a) => ({ ...a, issuedOn: a.issuedOn.toISOString() }))}
        employees={employees
          .filter((e) => e.active)
          .map((e) => ({ id: e.id, name: e.name, employeeCode: e.employeeCode }))}
      />
    </>
  );
}
