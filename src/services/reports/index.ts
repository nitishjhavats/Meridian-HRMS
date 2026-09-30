import { prisma } from "@/lib/db/prisma";
import { employeeName } from "@/domain/employees/name";
import type { AuthContext } from "@/lib/auth/context";
import { requireModule, requireOrg, requirePermission, visibleEmployeeIds } from "@/lib/auth/guard";
import { ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { paiseToRupees } from "@/domain/money";
import { PRESENT_STATUSES } from "@/domain/attendance/monthTotals";
import { reportedRunIds } from "@/domain/payroll/reportedRuns";
import { accruedForRow, monthsWorkedInYear } from "@/domain/leave";
import {
  allocationOverrides,
  designationAllocation,
  resolveAllocation,
} from "@/domain/leave/allocation";
import { type DateOnly, endOfMonth, monthLabel, startOfMonth, todayInZone } from "@/domain/date";

/**
 * Reports.
 *
 * Every report returns `(string | number | null)[][]` — a header row followed by
 * data rows — which `csvResponse` turns into a download and the screen renders
 * as a preview. One shape means the preview is provably the file: there is no
 * second code path that could format a column differently.
 *
 * Money is emitted as **rupees, not paise**, and as a bare number rather than a
 * formatted string. A spreadsheet must be able to sum the column, and "₹1,234.00"
 * is text to Excel.
 */

export type ReportKind =
  | "attendance-summary"
  | "attendance-daily"
  | "leave-balances"
  | "payroll-register"
  | "salary-breakdown"
  | "salary-disbursement"
  | "headcount";

export interface ReportDefinition {
  kind: ReportKind;
  name: string;
  description: string;
  /** Which inputs the form should show. */
  needs: ("month" | "dateRange")[];
  /** Module that must be live for this report to make sense. */
  module?: "attendance" | "leave" | "payroll";
}

export const REPORTS: readonly ReportDefinition[] = [
  {
    kind: "attendance-summary",
    name: "Attendance summary",
    description: "One row per employee: present, absent, leave and late days for a month.",
    needs: ["month"],
    module: "attendance",
  },
  {
    kind: "attendance-daily",
    name: "Attendance day register",
    description: "One row per employee per day, with times and any override.",
    needs: ["dateRange"],
    module: "attendance",
  },
  {
    kind: "leave-balances",
    name: "Leave balances",
    description: "Allocated, used and remaining days by leave type.",
    needs: [],
    module: "leave",
  },
  {
    kind: "payroll-register",
    name: "Payroll register",
    description: "Gross, deductions and net for every employee in a payroll month.",
    needs: ["month"],
    module: "payroll",
  },
  {
    kind: "salary-breakdown",
    name: "Salary breakdown",
    description:
      "One column per earning and per deduction, so a figure can be traced back to the component that produced it.",
    needs: ["month"],
    module: "payroll",
  },
  {
    kind: "salary-disbursement",
    name: "Salary disbursement",
    description: "What was paid, what is outstanding, and by which method.",
    needs: ["month"],
    module: "payroll",
  },
  {
    kind: "headcount",
    name: "Headcount and attrition",
    description: "Current strength by department, plus joiners and leavers.",
    needs: [],
  },
];

export interface ReportOptions {
  year?: number;
  month?: number;
  from?: DateOnly;
  to?: DateOnly;
}

export interface ReportResult {
  name: string;
  filename: string;
  rows: (string | number | null)[][];
}

function toDate(value: DateOnly): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

/** Rupees as a number a spreadsheet can add up. */
const rupees = (paise: number | null | undefined): number | null =>
  paise == null ? null : paiseToRupees(paise);

/**
 * The days an attendance summary for one month covers — inclusive, both ends.
 *
 * The end used to be written as `-31` on the assumption that a date past the
 * month's last day would simply match nothing. It does not: `2026-02-31` parses
 * as 3 March, so every month shorter than 31 days quietly counted the first
 * days of the next one, and the preview and the CSV agreed with each other
 * because they share these rows. The calendar knows how long the month is;
 * ask it.
 */
export function attendanceSummaryWindow(
  year: number,
  month: number,
): { start: DateOnly; end: DateOnly } {
  return { start: startOfMonth(year, month), end: endOfMonth(year, month) };
}

/**
 * The payroll runs a report for one month may read — at most one.
 *
 * Every payroll report used to match its rows on the period alone, and a month
 * that has been revised has more than one run under that period: the locked run
 * that was paid, plus the revision opened to correct it. So each employee
 * appeared once per revision and every money column was summed twice, which is
 * a payroll register that does not reconcile with the bank. `reportedRunIds`
 * picks the locked run, else the newest approved one — the run that was
 * actually paid — and never more than one per month.
 *
 * Returned as an array because that is what `in` takes: an empty one is a real
 * answer, and matches nothing, which is the right report for a month with no
 * run worth reporting.
 */
async function runIdsForMonth(orgId: string, year: number, month: number): Promise<string[]> {
  const runs = await prisma.payrollRun.findMany({
    // Scoped by organisation like every other read here: another tenant's March
    // is not this tenant's March.
    where: { organizationId: orgId, periodYear: year, periodMonth: month },
    select: { id: true, periodYear: true, periodMonth: true, revision: true, status: true },
  });
  return reportedRunIds(runs);
}

export async function runReport(
  ctx: AuthContext,
  kind: ReportKind,
  options: ReportOptions = {},
): Promise<ReportResult> {
  requireOrg(ctx);
  requirePermission(ctx, "report.export");
  // The screen and the nav already honour the organisation-wide switch; the
  // API has to as well, or a bookmarked download keeps working after Reports
  // is turned off for the org, a designation or this one person.
  requireModule(ctx, "reports");

  const definition = REPORTS.find((r) => r.kind === kind);
  if (!definition) throw new ValidationError("That is not a report this system produces.");
  if (definition.module && !ctx.modules.has(definition.module)) {
    throw new ValidationError(`The ${definition.module} module is switched off.`);
  }

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const year = options.year ?? Number(today.slice(0, 4));
  const month = options.month ?? Number(today.slice(5, 7));

  // Every report is confined to the employees the caller may already see.
  const visible = await visibleEmployeeIds(ctx, "employee.read");

  const result = await build(ctx, kind, { year, month, options, visible, today });

  await writeAudit(ctx, {
    action: "export.requested",
    entityType: "Report",
    metadata: { kind, year, month, rows: result.rows.length - 1 },
  });

  return result;
}

interface BuildArgs {
  year: number;
  month: number;
  options: ReportOptions;
  visible: string[] | null;
  today: DateOnly;
}

async function build(
  ctx: AuthContext,
  kind: ReportKind,
  { year, month, options, visible, today }: BuildArgs,
): Promise<ReportResult> {
  const orgId = ctx.organizationId!;
  const employeeWhere: Record<string, unknown> = { organizationId: orgId };
  if (visible !== null) employeeWhere.id = { in: visible };

  switch (kind) {
    // ---------------------------------------------------------------- attendance
    case "attendance-summary": {
      const { start, end } = attendanceSummaryWindow(year, month);

      const employees = await prisma.employee.findMany({
        where: { ...employeeWhere, active: true },
        orderBy: { employeeCode: "asc" },
        select: {
          id: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          user: { select: { name: true } },
          department: { select: { name: true } },
          attendanceDays: {
            where: { date: { gte: toDate(start), lte: toDate(end) } },
            select: { status: true, lateMinutes: true, workedMinutes: true, overtimeMinutes: true },
          },
        },
      });

      const rows: (string | number | null)[][] = [
        ["Code", "Name", "Department", "Present", "Half days", "Absent", "Paid leave",
         "Unpaid leave", "Week offs", "Holidays", "Late arrivals", "Worked hours", "Overtime hours"],
      ];

      for (const e of employees) {
        const count = (statuses: readonly string[]) =>
          e.attendanceDays.filter((d) => statuses.includes(d.status)).length;

        rows.push([
          e.employeeCode,
          employeeName(e, ""),
          e.department?.name ?? "",
          // The same set the grid and the reception screen tally, so the CSV
          // and the screen it is exported from cannot disagree about a day.
          // Half days have their own column, which is why this is the
          // monthTotals list and not the headcount one.
          count(PRESENT_STATUSES),
          count(["HALF_DAY"]),
          count(["ABSENT"]),
          count(["PAID_LEAVE"]),
          count(["UNPAID_LEAVE"]),
          count(["WEEK_OFF", "DAY_OFF"]),
          count(["HOLIDAY"]),
          e.attendanceDays.filter((d) => d.lateMinutes > 0).length,
          Math.round(e.attendanceDays.reduce((s, d) => s + d.workedMinutes, 0) / 6) / 10,
          Math.round(e.attendanceDays.reduce((s, d) => s + d.overtimeMinutes, 0) / 6) / 10,
        ]);
      }

      return {
        name: `Attendance summary — ${monthLabel(year, month)}`,
        filename: `attendance-summary-${year}-${String(month).padStart(2, "0")}.csv`,
        rows,
      };
    }

    case "attendance-daily": {
      const from = options.from ?? `${year}-${String(month).padStart(2, "0")}-01`;
      const to = options.to ?? today;

      const days = await prisma.attendanceDay.findMany({
        where: {
          organizationId: orgId,
          ...(visible !== null ? { employeeId: { in: visible } } : {}),
          date: { gte: toDate(from), lte: toDate(to) },
        },
        orderBy: [{ date: "asc" }, { employeeId: "asc" }],
        take: 20_000,
        select: {
          date: true,
          status: true,
          systemStatus: true,
          firstCheckInAt: true,
          lastCheckOutAt: true,
          workedMinutes: true,
          lateMinutes: true,
          overtimeMinutes: true,
          overrideReason: true,
          employee: {
            select: { employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
          },
        },
      });

      const rows: (string | number | null)[][] = [
        ["Date", "Code", "Name", "Status", "System status", "In", "Out",
         "Worked minutes", "Late minutes", "Overtime minutes", "Override reason"],
      ];

      for (const d of days) {
        rows.push([
          toDateOnly(d.date),
          d.employee.employeeCode,
          employeeName(d.employee, ""),
          d.status,
          // Kept beside the final status so a corrected day is visible as one.
          d.systemStatus,
          d.firstCheckInAt?.toISOString() ?? null,
          d.lastCheckOutAt?.toISOString() ?? null,
          d.workedMinutes,
          d.lateMinutes,
          d.overtimeMinutes,
          d.overrideReason,
        ]);
      }

      return {
        name: `Attendance register — ${from} to ${to}`,
        filename: `attendance-register-${from}-to-${to}.csv`,
        rows,
      };
    }

    // ---------------------------------------------------------------- leave
    case "leave-balances": {
      const [balances, allocationRows] = await Promise.all([
        prisma.leaveBalance.findMany({
          where: {
            organizationId: orgId,
            year,
            ...(visible !== null ? { employeeId: { in: visible } } : {}),
          },
          orderBy: [{ employee: { employeeCode: "asc" } }],
          select: {
            leaveTypeId: true,
            allocated: true,
            accrued: true,
            used: true,
            carriedForward: true,
            encashed: true,
            leaveType: {
              select: {
                code: true,
                name: true,
                accrualMode: true,
                annualAllocation: true,
                monthlyAccrual: true,
              },
            },
            employee: {
              select: {
                employeeCode: true,
                joiningDate: true,
                firstName: true,
                lastName: true,
                designationId: true,
                user: { select: { name: true } },
                department: { select: { name: true } },
              },
            },
          },
        }),
        // The per-designation entitlement. This report is what people reconcile
        // the leave register against, so it reading the company-wide figure
        // while the balance screen read the designation's would have them
        // chasing a discrepancy that is only two files disagreeing.
        prisma.designationLeaveAllocation.findMany({
          where: { organizationId: orgId },
          select: { leaveTypeId: true, designationId: true, annualAllocation: true },
        }),
      ]);
      const overrides = allocationOverrides(allocationRows);

      const rows: (string | number | null)[][] = [
        ["Code", "Name", "Department", "Leave type", "Allocated", "Accrued",
         "Carried forward", "Used", "Encashed", "Remaining"],
      ];

      for (const b of balances) {
        const accrues = b.leaveType.accrualMode === "MONTHLY";
        const designation = designationAllocation(
          overrides,
          b.leaveTypeId,
          b.employee.designationId,
        );
        // Derived rather than read straight off the row: `accrued` is a stored
        // column nothing recomputes, and a row created by an approval or by the
        // year-end run holds a zero in it. See `accruedForRow`.
        const accrued = accruedForRow(Number(b.accrued), {
          annualAllocation: resolveAllocation({
            designation,
            type: b.leaveType.annualAllocation,
          }),
          monthlyAccrual: Number(b.leaveType.monthlyAccrual),
          accrualMode: b.leaveType.accrualMode as "ANNUAL" | "MONTHLY" | "NONE",
          monthsWorked: monthsWorkedInYear(
            year,
            b.employee.joiningDate ? b.employee.joiningDate.toISOString().slice(0, 10) as DateOnly : null,
            today,
          ),
        });
        // The row's own figure still wins — it is the one person whose contract
        // says something different — and falls through to their designation and
        // then the company only when there is nothing on the row to read.
        const allocated = resolveAllocation({
          personal: b.allocated,
          designation,
          type: b.leaveType.annualAllocation,
        });
        const granted = accrues ? accrued : allocated;
        rows.push([
          b.employee.employeeCode,
          employeeName(b.employee, ""),
          b.employee.department?.name ?? "",
          `${b.leaveType.name} (${b.leaveType.code})`,
          allocated,
          accrued,
          Number(b.carriedForward),
          Number(b.used),
          Number(b.encashed),
          Math.round((granted + Number(b.carriedForward) - Number(b.used) - Number(b.encashed)) * 100) / 100,
        ]);
      }

      return {
        name: `Leave balances — ${year}`,
        filename: `leave-balances-${year}.csv`,
        rows,
      };
    }

    // ---------------------------------------------------------------- payroll
    case "payroll-register": {
      // One run for the month, not every revision of it. See `runIdsForMonth`.
      const runIds = await runIdsForMonth(orgId, year, month);
      const items = await prisma.payrollItem.findMany({
        where: {
          organizationId: orgId,
          ...(visible !== null ? { employeeId: { in: visible } } : {}),
          payrollRunId: { in: runIds },
        },
        orderBy: { employee: { employeeCode: "asc" } },
        select: {
          ctcMonthlyPaise: true,
          basisDays: true,
          payableDays: true,
          grossPaise: true,
          deductionsPaise: true,
          advanceRecoveredPaise: true,
          netPaise: true,
          paidPaise: true,
          settlement: true,
          run: { select: { status: true, revision: true } },
          employee: {
            select: {
              employeeCode: true,
              firstName: true,
              lastName: true,
              user: { select: { name: true } },
              department: { select: { name: true } },
              designation: { select: { title: true } },
            },
          },
        },
      });

      const rows: (string | number | null)[][] = [
        ["Code", "Name", "Department", "Designation", "Monthly CTC", "Basis days",
         "Payable days", "Gross", "Deductions", "Advance recovered", "Net", "Paid",
         "Outstanding", "Settlement", "Run status", "Revision"],
      ];

      for (const i of items) {
        rows.push([
          i.employee.employeeCode,
          employeeName(i.employee, ""),
          i.employee.department?.name ?? "",
          i.employee.designation?.title ?? "",
          rupees(i.ctcMonthlyPaise),
          Number(i.basisDays),
          Number(i.payableDays),
          rupees(i.grossPaise),
          rupees(i.deductionsPaise),
          rupees(i.advanceRecoveredPaise),
          rupees(i.netPaise),
          rupees(i.paidPaise),
          rupees(i.netPaise - i.paidPaise),
          i.settlement,
          i.run.status,
          i.run.revision,
        ]);
      }

      return {
        name: `Payroll register — ${monthLabel(year, month)}`,
        filename: `payroll-register-${year}-${String(month).padStart(2, "0")}.csv`,
        rows,
      };
    }

    /**
     * The register with the totals opened up.
     *
     * `payroll-register` gives gross, deductions and net -- which answers "what
     * did we pay" and not "why". Reconciling a figure against a component, or
     * proving to somebody which deduction took their money, meant opening one
     * payslip at a time.
     *
     * The columns are worked out from the data rather than fixed, because an
     * organisation chooses its own components and one that added a shift
     * allowance last month should not have to wait for us to add a column. The
     * order comes from the first item that mentions each code, so it follows the
     * salary structure rather than the alphabet.
     */
    case "salary-breakdown": {
      // One run for the month, not every revision of it. See `runIdsForMonth`.
      const runIds = await runIdsForMonth(orgId, year, month);
      const items = await prisma.payrollItem.findMany({
        where: {
          organizationId: orgId,
          ...(visible !== null ? { employeeId: { in: visible } } : {}),
          payrollRunId: { in: runIds },
        },
        orderBy: { employee: { employeeCode: "asc" } },
        select: {
          earnings: true,
          deductions: true,
          basisDays: true,
          payableDays: true,
          absentDays: true,
          grossPaise: true,
          deductionsPaise: true,
          advanceRecoveredPaise: true,
          netPaise: true,
          employee: {
            select: {
              employeeCode: true,
              firstName: true,
              lastName: true,
              department: { select: { name: true } },
              designation: { select: { title: true } },
            },
          },
        },
      });

      interface Line {
        code?: unknown;
        label?: unknown;
        amountPaise?: unknown;
      }

      /** Line items as `{ code -> paise }`, ignoring anything malformed. */
      function byCode(raw: unknown): Map<string, { label: string; amountPaise: number }> {
        const out = new Map<string, { label: string; amountPaise: number }>();
        if (!Array.isArray(raw)) return out;
        for (const line of raw as Line[]) {
          const code = typeof line?.code === "string" ? line.code : null;
          const amount = typeof line?.amountPaise === "number" ? line.amountPaise : null;
          if (!code || amount === null) continue;
          const label = typeof line.label === "string" && line.label ? line.label : code;
          // Two lines with the same code add up rather than one hiding the
          // other -- an adjustment can share a code with a component.
          const existing = out.get(code);
          out.set(code, {
            label,
            amountPaise: (existing?.amountPaise ?? 0) + amount,
          });
        }
        return out;
      }

      const parsed = items.map((item) => ({
        item,
        earnings: byCode(item.earnings),
        deductions: byCode(item.deductions),
      }));

      const earningColumns: { code: string; label: string }[] = [];
      const deductionColumns: { code: string; label: string }[] = [];
      for (const row of parsed) {
        for (const [code, line] of row.earnings) {
          if (!earningColumns.some((c) => c.code === code)) {
            earningColumns.push({ code, label: line.label });
          }
        }
        for (const [code, line] of row.deductions) {
          if (!deductionColumns.some((c) => c.code === code)) {
            deductionColumns.push({ code, label: line.label });
          }
        }
      }

      const rows: (string | number | null)[][] = [
        [
          "Code",
          "Name",
          "Department",
          "Designation",
          "Basis days",
          "Payable days",
          "Absent days",
          ...earningColumns.map((c) => c.label),
          "Gross",
          ...deductionColumns.map((c) => c.label),
          "Total deductions",
          "Advance recovered",
          "Net",
        ],
      ];

      for (const { item, earnings, deductions } of parsed) {
        rows.push([
          item.employee.employeeCode,
          employeeName(item.employee, ""),
          item.employee.department?.name ?? "",
          item.employee.designation?.title ?? "",
          Number(item.basisDays),
          Number(item.payableDays),
          Number(item.absentDays),
          // Zero rather than blank: a spreadsheet sums a column of numbers, and
          // a gap in the middle of one is a column that will not add up.
          ...earningColumns.map((c) => rupees(earnings.get(c.code)?.amountPaise ?? 0)),
          rupees(item.grossPaise),
          ...deductionColumns.map((c) => rupees(deductions.get(c.code)?.amountPaise ?? 0)),
          rupees(item.deductionsPaise),
          rupees(item.advanceRecoveredPaise),
          rupees(item.netPaise),
        ]);
      }

      return {
        name: "Salary breakdown",
        // Every other report names a `.csv` file; this one named none, so the
        // browser saved "salary-breakdown-2026-08" with no extension and the
        // operating system had nothing to open it with -- on the one report
        // whose whole point is to be opened in a spreadsheet. The header is
        // `csvResponse`'s and has always said `text/csv; charset=utf-8`; only
        // the name the browser saves it under was wrong.
        filename: `salary-breakdown-${year}-${String(month).padStart(2, "0")}.csv`,
        rows,
      };
    }

    case "salary-disbursement": {
      // One run for the month, not every revision of it. See `runIdsForMonth`.
      // A payment hangs off the item it settled, so a revised month otherwise
      // reported the payments against the locked run *and* the ones recorded
      // against its replacement — the same salary listed as paid twice.
      const runIds = await runIdsForMonth(orgId, year, month);
      const payments = await prisma.salaryPayment.findMany({
        where: {
          item: {
            organizationId: orgId,
            ...(visible !== null ? { employeeId: { in: visible } } : {}),
            payrollRunId: { in: runIds },
          },
        },
        orderBy: { paidOn: "asc" },
        select: {
          paidOn: true,
          amountPaise: true,
          method: true,
          reference: true,
          remarks: true,
          item: {
            select: {
              netPaise: true,
              employee: {
                select: { employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
              },
            },
          },
        },
      });

      const rows: (string | number | null)[][] = [
        ["Paid on", "Code", "Name", "Amount", "Method", "Reference", "Net for the month", "Note"],
      ];

      for (const p of payments) {
        rows.push([
          toDateOnly(p.paidOn),
          p.item.employee.employeeCode,
          employeeName(p.item.employee, ""),
          rupees(p.amountPaise),
          p.method,
          p.reference,
          rupees(p.item.netPaise),
          p.remarks,
        ]);
      }

      return {
        name: `Salary disbursement — ${monthLabel(year, month)}`,
        filename: `salary-disbursement-${year}-${String(month).padStart(2, "0")}.csv`,
        rows,
      };
    }

    // ---------------------------------------------------------------- people
    case "headcount": {
      const employees = await prisma.employee.findMany({
        where: employeeWhere,
        orderBy: { employeeCode: "asc" },
        select: {
          employeeCode: true,
          active: true,
          employmentState: true,
          employmentType: true,
          joiningDate: true,
          exitDate: true,
          firstName: true,
          lastName: true,
          user: { select: { name: true, email: true } },
          department: { select: { name: true } },
          designation: { select: { title: true } },
          workLocation: { select: { name: true } },
        },
      });

      const rows: (string | number | null)[][] = [
        ["Code", "Name", "Email", "Department", "Designation", "Location",
         "Employment type", "State", "Active", "Joined", "Exited", "Tenure (months)"],
      ];

      const now = new Date();
      for (const e of employees) {
        const joined = e.joiningDate;
        const left = e.exitDate;
        const months =
          joined != null
            ? Math.max(
                0,
                Math.round(((left ?? now).getTime() - joined.getTime()) / (30.44 * 86_400_000)),
              )
            : null;

        rows.push([
          e.employeeCode,
          employeeName(e, ""),
          e.user?.email ?? "",
          e.department?.name ?? "",
          e.designation?.title ?? "",
          e.workLocation?.name ?? "",
          e.employmentType,
          e.employmentState,
          e.active ? "Yes" : "No",
          joined ? toDateOnly(joined) : null,
          left ? toDateOnly(left) : null,
          months,
        ]);
      }

      return { name: "Headcount and attrition", filename: `headcount-${today}.csv`, rows };
    }
  }
}

/** The reports this person may actually run, for the picker. */
export function availableReports(ctx: AuthContext): ReportDefinition[] {
  if (!ctx.permissions.has("report.export")) return [];
  // Nothing at all when the module itself is off — the same answer `runReport`
  // gives, so the picker never offers a report the API will refuse.
  if (!ctx.modules.has("reports")) return [];
  return REPORTS.filter((r) => !r.module || ctx.modules.has(r.module));
}
