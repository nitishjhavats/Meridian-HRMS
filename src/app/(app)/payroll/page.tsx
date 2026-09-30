import Link from "next/link";
import { BadgeIndianRupee } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { hasPermission } from "@/lib/auth/guard";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listRuns } from "@/services/payroll/runs";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDate, formatMoney, pluralise } from "@/lib/utils";
import { MONTH_NAMES } from "@/domain/date";
import { OpenMonth } from "./OpenMonth";

export const metadata = { title: "Payroll" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  DRAFT: "neutral",
  CALCULATED: "info",
  APPROVED: "warning",
  LOCKED: "success",
  CANCELLED: "danger",
} as const;

export default async function PayrollPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    // A team lead holds `payroll.read.team` and belongs here too — on a reduced
    // version of the screen, not on a "you do not have access" page.
    anyPermission: ["payroll.read.all", "payroll.read.team"],
    module: "payroll",
    what: "payroll",
  });
  if (denied) return denied;

  // The service decides what the figures cover; this only decides how they are
  // described, so the two can never disagree about scope.
  const teamOnly = !hasPermission(ctx, "payroll.read.all");

  const runs = await listRuns(ctx);
  const now = new Date();

  // The last finished month is the one an admin almost always wants next.
  const suggested = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const alreadyOpen = runs.some(
    (r) => r.periodYear === suggested.getFullYear() && r.periodMonth === suggested.getMonth() + 1,
  );

  return (
    <>
      <PageHeader
        title="Payroll"
        description={
          teamOnly
            ? "Your team's pay, month by month. Every figure here counts only the people who report to you."
            : "Each month is calculated from attendance under the rules in force at the time."
        }
        action={
          hasPermission(ctx, "payroll.run") ? (
            <OpenMonth
              defaultYear={suggested.getFullYear()}
              defaultMonth={suggested.getMonth() + 1}
              suggestionOpen={alreadyOpen}
              suggestionLabel={`${MONTH_NAMES[suggested.getMonth()]} ${suggested.getFullYear()}`}
            />
          ) : undefined
        }
      />

      <Section
        title={teamOnly ? "Your team's runs" : "Runs"}
        description={
          teamOnly
            ? "Newest first. A month appears once your team is in it."
            : "Newest first. A reopened month appears as a new revision."
        }
      >
        <ResponsiveList
          items={runs}
          empty={
            <EmptyState
              icon={BadgeIndianRupee}
              title={teamOnly ? "Nothing to show yet" : "No payroll yet"}
              description={
                teamOnly
                  ? "A month appears here once it has been calculated and somebody who reports to you is in it."
                  : "Open a month to calculate it."
              }
            />
          }
          head={
            <>
              <TH>Period</TH>
              <TH>Employees</TH>
              <TH numeric>Net</TH>
              <TH numeric>Paid</TH>
              <TH numeric>Outstanding</TH>
              <TH>Status</TH>
              <TH>Locked</TH>
            </>
          }
          row={(run) => (
            <TR key={run.id}>
              <TD>
                <Link href={`/payroll/${run.id}`} className="font-medium hover:underline">
                  {run.label}
                </Link>
                {run.revision > 1 ? (
                  <span className="ml-1.5 text-xs text-muted-foreground">rev {run.revision}</span>
                ) : null}
              </TD>
              <TD className="tabular">{run.employees}</TD>
              <TD numeric>{formatMoney(run.netPaise)}</TD>
              <TD numeric className="text-success-text">
                {run.paidPaise > 0 ? formatMoney(run.paidPaise) : "—"}
              </TD>
              <TD numeric className={run.outstandingPaise > 0 ? "text-warning-text" : ""}>
                {run.outstandingPaise > 0 ? formatMoney(run.outstandingPaise) : "—"}
              </TD>
              <TD>
                <Badge tone={STATUS_TONE[run.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                  {run.status.toLowerCase()}
                </Badge>
              </TD>
              <TD className="text-xs text-muted-foreground">
                {run.lockedAt ? formatDate(run.lockedAt) : "—"}
              </TD>
            </TR>
          )}
          card={(run) => (
            <Link key={run.id} href={`/payroll/${run.id}`} className="block">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">
                    {run.label}
                    {run.revision > 1 ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        rev {run.revision}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {pluralise(run.employees, "employee")}
                  </p>
                </div>
                <Badge tone={STATUS_TONE[run.status as keyof typeof STATUS_TONE] ?? "neutral"}>
                  {run.status.toLowerCase()}
                </Badge>
              </div>
              <div className="mt-1.5 flex justify-between text-xs">
                <span className="text-muted-foreground">Net {formatMoney(run.netPaise)}</span>
                {run.outstandingPaise > 0 ? (
                  <span className="text-warning-text">
                    {formatMoney(run.outstandingPaise)} outstanding
                  </span>
                ) : (
                  <span className="text-success-text">fully paid</span>
                )}
              </div>
            </Link>
          )}
        />
      </Section>
    </>
  );
}
