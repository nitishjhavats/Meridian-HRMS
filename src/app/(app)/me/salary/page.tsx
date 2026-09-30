import { BadgeIndianRupee } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { formatMoney, formatMoneyCompact } from "@/lib/utils";
import { monthLabel, todayInZone } from "@/domain/date";
import { MySalaryList } from "./MySalaryList";

export const metadata = { title: "My salary" };
export const dynamic = "force-dynamic";

export default async function MySalaryPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    ownEmployeeRecord: true,
    permission: "payroll.read.self",
    module: "payroll",
    what: "your salary",
  });
  if (denied) return denied;

  if (!ctx.employeeId) {
    return (
      <>
        <PageHeader title="My salary" />
        <EmptyState
          icon={BadgeIndianRupee}
          title="No employee record"
          description="Your login is not linked to an employee record yet. Ask HR to connect them."
        />
      </>
    );
  }

  // Only runs that have been approved are shown. A draft calculation is a
  // working figure, and showing it to an employee invites a conversation about
  // a number that has not been agreed yet.
  const [items, salaryOnRecord] = await Promise.all([
    prisma.payrollItem.findMany({
      where: {
        employeeId: ctx.employeeId,
        run: { status: { in: ["APPROVED", "LOCKED"] } },
      },
      include: {
        run: { select: { periodYear: true, periodMonth: true, status: true } },
        payments: { select: { amountPaise: true, paidOn: true } },
      },
      orderBy: [{ run: { periodYear: "desc" } }, { run: { periodMonth: "desc" } }],
      take: 24,
    }),
    // Whether a sample can be built at all. Asked here so the screen can either
    // offer it or say why it cannot, rather than showing a control that returns
    // an error — and it is only the existence of a revision, never an amount:
    // the page renders no salary of its own.
    //
    // The same predicate `renderMySamplePayslip` uses, deliberately: a revision
    // dated next month exists but is not in force, and asking a looser question
    // here would put a button on screen that the service then refuses.
    prisma.salaryProfile.findFirst({
      where: {
        organizationId: ctx.organizationId!,
        employeeId: ctx.employeeId,
        effectiveFrom: {
          lte: new Date(`${todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata")}T00:00:00.000Z`),
        },
      },
      select: { id: true },
    }),
  ]);

  const rows = items.map((item) => ({
    id: item.id,
    label: monthLabel(item.run.periodYear, item.run.periodMonth),
    grossPaise: item.grossPaise,
    deductionsPaise: item.deductionsPaise,
    netPaise: item.netPaise,
    paidPaise: item.paidPaise,
    settlement: item.settlement,
    payableDays: Number(item.payableDays),
    basisDays: Number(item.basisDays),
  }));

  const latest = rows[0];
  const outstanding = rows.reduce((sum, r) => sum + (r.netPaise - r.paidPaise), 0);
  const yearToDate = items
    .filter((i) => i.run.periodYear === new Date().getFullYear())
    .reduce((sum, i) => sum + i.netPaise, 0);

  return (
    <>
      <PageHeader
        title="My salary"
        description="Your payslips, and how each figure was worked out."
      />

      {latest ? (
        <StatGrid>
          <Stat
            label={`${latest.label} net`}
            value={formatMoneyCompact(latest.netPaise)}
            hint={formatMoney(latest.netPaise)}
            icon={BadgeIndianRupee}
            tone="primary"
          />
          <Stat
            label="Paid"
            value={formatMoneyCompact(latest.paidPaise)}
            hint={latest.settlement.replaceAll("_", " ").toLowerCase()}
            icon={BadgeIndianRupee}
            tone={latest.settlement === "PAID" ? "success" : "warning"}
          />
          <Stat
            label="Outstanding"
            value={formatMoneyCompact(outstanding)}
            hint="across all months"
            icon={BadgeIndianRupee}
            tone={outstanding > 0 ? "warning" : "neutral"}
          />
          <Stat
            label="This year"
            value={formatMoneyCompact(yearToDate)}
            hint="net earned"
            icon={BadgeIndianRupee}
          />
        </StatGrid>
      ) : null}

      <div className="mt-5">
        <Section
          title="Payslips"
          description="Tap a month to see every earning, deduction and the arithmetic behind it."
          action={
            latest ? (
              <Badge tone={latest.settlement === "PAID" ? "success" : "warning"}>
                {latest.label} {latest.settlement.replaceAll("_", " ").toLowerCase()}
              </Badge>
            ) : undefined
          }
        >
          <MySalaryList rows={rows} hasSalaryOnRecord={salaryOnRecord !== null} />
        </Section>
      </div>
    </>
  );
}
