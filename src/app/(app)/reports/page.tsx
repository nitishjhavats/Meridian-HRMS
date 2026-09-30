import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { availableReports } from "@/services/reports";
import { PageHeader } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { ReportRunner, type ReportOption } from "./ReportRunner";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "report.export",
    module: "reports",
    what: "reports",
  });
  if (denied) return denied;

  // A report whose module is switched off is not offered at all — better than
  // listing it and refusing on click.
  const reports = availableReports(ctx);

  return (
    <>
      <PageHeader
        title="Reports"
        description="Run a report, check it on screen, then download the same rows as CSV."
      />

      {reports.length === 0 ? (
        <Alert tone="info" title="No reports available">
          Every report depends on a module that is currently switched off.
        </Alert>
      ) : (
        <ReportRunner reports={reports as ReportOption[]} />
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Reports only ever cover the people you can already see. Money is exported in rupees as
        plain numbers, so a spreadsheet can total the column.
      </p>
    </>
  );
}
