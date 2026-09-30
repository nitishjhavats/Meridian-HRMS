import Link from "next/link";
import { ArrowLeft, BadgeIndianRupee, CheckCircle2, Clock, Users } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { asNotFound } from "@/lib/auth/notFound";
import { hasPermission } from "@/lib/auth/guard";
import { getRunDetail } from "@/services/payroll/runs";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { formatMoney, formatMoneyCompact, pluralise } from "@/lib/utils";
import { RunControls } from "./RunControls";
import { RunTable } from "./RunTable";

export const metadata = { title: "Payroll run" };
export const dynamic = "force-dynamic";

const STATUS_TONE = {
  DRAFT: "neutral",
  CALCULATED: "info",
  APPROVED: "warning",
  LOCKED: "success",
  CANCELLED: "danger",
} as const;

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    // `payroll.read.team` lands on the same page with its figures narrowed to
    // the reporting line, rather than being refused outright.
    anyPermission: ["payroll.read.all", "payroll.read.team"],
    module: "payroll",
    what: "payroll",
  });
  if (denied) return denied;

  const detail = await getRunDetail(ctx, id).catch(asNotFound);

  const paidCount = detail.items.filter((i) => i.settlement === "PAID").length;

  /**
   * Nothing on a scoped view may change the run.
   *
   * The service is the boundary and refuses these anyway, but a viewer who can
   * only see part of a run must not be offered a control that would act on all
   * of it — so scope wins over the permission, whatever an individual grant says.
   */
  const canAct = !detail.scoped;

  return (
    <>
      <Link
        href="/payroll"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All payroll runs
      </Link>

      <PageHeader
        title={detail.label}
        description={[
          detail.run.revision > 1 ? `Revision ${detail.run.revision}` : null,
          `${pluralise(detail.items.length, "employee")}${detail.scoped ? " in your team" : ""}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        action={
          <Badge tone={STATUS_TONE[detail.run.status as keyof typeof STATUS_TONE] ?? "neutral"}>
            {detail.run.status.toLowerCase()}
          </Badge>
        }
      />

      {detail.run.status === "LOCKED" ? (
        <div className="mb-4">
          <Alert tone="success" title="This run is locked">
            The policy it was calculated under is frozen with it, so changing settings now cannot
            alter these figures.{canAct ? " Payments can still be recorded." : ""}
          </Alert>
        </div>
      ) : null}

      {detail.run.note ? (
        <div className="mb-4">
          <Alert tone="info">{detail.run.note}</Alert>
        </div>
      ) : null}

      <StatGrid>
        <Stat
          label="Net payable"
          value={formatMoneyCompact(detail.totals.netPaise)}
          hint={formatMoney(detail.totals.netPaise)}
          icon={BadgeIndianRupee}
          tone="primary"
        />
        <Stat
          label="Paid"
          value={formatMoneyCompact(detail.totals.paidPaise)}
          hint={`${paidCount} of ${detail.items.length} settled`}
          icon={CheckCircle2}
          tone="success"
        />
        <Stat
          label="Outstanding"
          value={formatMoneyCompact(detail.totals.outstandingPaise)}
          icon={Clock}
          tone={detail.totals.outstandingPaise > 0 ? "warning" : "neutral"}
        />
        <Stat
          label="Employees"
          value={detail.items.length}
          hint={detail.scoped ? "in your reporting line" : undefined}
          icon={Users}
        />
      </StatGrid>

      {canAct ? (
        <div className="mt-4">
          <RunControls
            runId={detail.run.id}
            status={detail.run.status}
            label={detail.label}
            employees={detail.items.length}
            canRun={hasPermission(ctx, "payroll.run")}
            canApprove={hasPermission(ctx, "payroll.approve")}
            canLock={hasPermission(ctx, "payroll.finalize")}
            canUnlock={hasPermission(ctx, "payroll.unlock")}
            canDisburse={hasPermission(ctx, "payroll.disburse")}
          />
        </div>
      ) : null}

      {detail.scoped ? (
        <div className="mt-4">
          <Section
            title="Whose figures these are"
            description="So a total on this page is never mistaken for the organisation's."
          >
            <div className="space-y-2 px-4 py-3 text-sm text-muted-foreground">
              {detail.scope === "team" ? (
                <p>
                  Your reporting line — you, and everyone who reports to you, directly or through
                  another manager.{" "}
                  <span className="font-medium text-foreground">
                    {pluralise(detail.items.length, "person", "people")}
                  </span>{" "}
                  from that line {detail.items.length === 1 ? "is" : "are"} in this run.
                </p>
              ) : (
                <p>Your own record, and nobody else&rsquo;s.</p>
              )}
              <p>
                Net payable, paid and outstanding above count only those people. The
                organisation&rsquo;s totals, and anybody outside your line, are not part of them.
              </p>
              <p>
                Calculating, approving, locking, adjusting and recording payment belong to payroll
                administrators, so those controls are not shown here.
              </p>
            </div>
          </Section>
        </div>
      ) : null}

      <div className="mt-5">
        <Section
          title={detail.scoped ? "Your team" : "Employees"}
          description="Open any row to see exactly how the figure was reached."
        >
          <RunTable
            items={detail.items}
            canDisburse={canAct && hasPermission(ctx, "payroll.disburse")}
            canAdjust={canAct && hasPermission(ctx, "payroll.adjust")}
            scoped={detail.scoped}
            runId={detail.run.id}
            runStatus={detail.run.status}
          />
        </Section>
      </div>
    </>
  );
}
