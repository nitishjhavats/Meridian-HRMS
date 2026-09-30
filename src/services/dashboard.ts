import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { hasPermission, requireOrg, visibleEmployeeIds } from "@/lib/auth/guard";
import { resolveScope } from "@/lib/auth/permissions";
import { todayInZone } from "@/domain/date";
import { PRESENT_STATUSES } from "@/domain/attendance/policy";
import { computeMrr } from "@/domain/billing/pricing";
import { summariseSeats } from "@/domain/billing/seats";
import { getMonthlyGrid } from "@/services/attendance/admin";

/**
 * Dashboard aggregates.
 *
 * Every query is tenant-filtered and, where the viewer only has team scope,
 * employee-filtered too — a Team Lead's dashboard counts their team, not the
 * whole company, without the page having to ask for that.
 */

export interface OrgDashboard {
  today: string;
  scope: "all" | "team" | "self";
  /**
   * This month, for somebody looking at their own record.
   *
   * Null for anybody with a team or an organisation to see: the headline tiles
   * answer "how is the company today" for them, which is the right question.
   * For one person it was the wrong one — a team member was shown their own
   * attendance counted as though they were a department, "Present today: 1".
   */
  myMonth: {
    label: string;
    present: number;
    absent: number;
    halfDays: number;
    leave: number;
    weekOff: number;
    holiday: number;
    /** Days in the month that are neither a week off nor a holiday. */
    workingDays: number;
  } | null;
  headcount: { total: number; active: number; onNotice: number; inTraining: number };
  attendance: { present: number; late: number; absent: number; onLeave: number; notMarked: number };
  seats: ReturnType<typeof summariseSeats>;
  pending: {
    leaveRequests: number;
    documentDeletions: number;
    regularisations: number;
    reimbursements: number;
  };
  payroll: {
    latest: {
      year: number;
      month: number;
      status: string;
      netPaise: number;
      paidPaise: number;
      outstandingPaise: number;
      employees: number;
    } | null;
  };
  upcomingHolidays: { id: string; name: string; date: string }[];
  announcements: { id: string; title: string; publishAt: Date; authorName: string }[];
}

export async function getOrgDashboard(ctx: AuthContext): Promise<OrgDashboard> {
  requireOrg(ctx);
  const orgId = ctx.organizationId;
  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";
  const today = todayInZone(timezone);
  const todayDate = new Date(`${today}T00:00:00.000Z`);

  // Team Leads see their own team; admins and above see everyone.
  //
  // Somebody with no `employee.read` scope at all has nobody to count -- an
  // empty list, never a refusal. `scopeFor` throws for that case, and an admin
  // can produce it by revoking "See their own record" on a Team Member. This
  // is where sign-in lands and where every denied screen sends people back
  // to, so a throw here left that person without a single working page.
  const employeeScope = resolveScope(ctx.permissions, "employee.read");
  const employeeIds =
    employeeScope === "all"
      ? null
      : employeeScope === null
        ? []
        : await visibleEmployeeIds(ctx, "employee.read");
  const scope = employeeIds === null ? "all" : employeeIds.length > 1 ? "team" : "self";
  const employeeFilter = employeeIds === null ? {} : { id: { in: employeeIds } };
  const attendanceFilter = employeeIds === null ? {} : { employeeId: { in: employeeIds } };
  // "Waiting for you" is work for the viewer to decide, and their own request
  // is not that. The team scope seeds itself with the viewer, so a team lead
  // whose only pending leave was their own read "1 pending item", followed
  // the row, and found the queue on /leave -- which leaves their own request
  // out of "Waiting for a decision" -- empty.
  const notOwn = ctx.employeeId ? { NOT: { employeeId: ctx.employeeId } } : {};

  const [
    total,
    active,
    onNotice,
    inTraining,
    attendanceToday,
    pendingLeave,
    pendingDeletions,
    pendingRegularisations,
    pendingReimbursements,
    latestRun,
    holidays,
    announcements,
  ] = await Promise.all([
    prisma.employee.count({ where: { organizationId: orgId, ...employeeFilter } }),
    prisma.employee.count({
      where: {
        organizationId: orgId,
        active: true,
        employmentState: { in: ["TRAINING", "PROBATION", "REGULAR", "CONFIRMED", "NOTICE_PERIOD"] },
        ...employeeFilter,
      },
    }),
    prisma.employee.count({
      where: { organizationId: orgId, employmentState: "NOTICE_PERIOD", ...employeeFilter },
    }),
    prisma.employee.count({
      where: { organizationId: orgId, employmentState: "TRAINING", ...employeeFilter },
    }),
    prisma.attendanceDay.groupBy({
      by: ["status"],
      where: { organizationId: orgId, date: todayDate, ...attendanceFilter },
      _count: { _all: true },
    }),
    prisma.leaveRequest.count({
      where: { organizationId: orgId, status: "PENDING", ...attendanceFilter, ...notOwn },
    }),
    // The deletion queue on `/documents` is only listed to somebody holding
    // `document.delete.approve`. Counting the organisation's requests for a
    // team lead told them N items were waiting, and the page then said zero.
    hasPermission(ctx, "document.delete.approve")
      ? prisma.documentDeletionRequest.count({
          where: { organizationId: orgId, status: "PENDING" },
        })
      : Promise.resolve(0),
    prisma.attendanceRegularisation.count({
      where: { organizationId: orgId, status: "PENDING", ...attendanceFilter, ...notOwn },
    }),
    prisma.reimbursementClaim.count({
      where: { organizationId: orgId, status: "SUBMITTED", ...attendanceFilter, ...notOwn },
    }),
    prisma.payrollRun.findFirst({
      where: { organizationId: orgId },
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }, { revision: "desc" }],
      select: {
        periodYear: true,
        periodMonth: true,
        status: true,
        totals: true,
        _count: { select: { items: true } },
      },
    }),
    prisma.holiday.findMany({
      where: { organizationId: orgId, date: { gte: todayDate } },
      orderBy: { date: "asc" },
      take: 4,
      select: { id: true, name: true, date: true },
    }),
    prisma.announcement.findMany({
      where: { organizationId: orgId, published: true, publishAt: { lte: new Date() } },
      orderBy: [{ pinned: "desc" }, { publishAt: "desc" }],
      take: 3,
      select: { id: true, title: true, publishAt: true, author: { select: { name: true } } },
    }),
  ]);

  const byStatus = (statuses: readonly string[]) =>
    attendanceToday
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + row._count._all, 0);

  // The headcount list, not a copy of it: this tile is read during the working
  // day, when most rows are still CHECKED_IN, and a private list here would have
  // shown everybody in the building as not present until they left.
  const present = byStatus(PRESENT_STATUSES);
  const marked = attendanceToday.reduce((sum, row) => sum + row._count._all, 0);
  const lateToday = await prisma.attendanceDay.count({
    where: { organizationId: orgId, date: todayDate, lateMinutes: { gt: 0 }, ...attendanceFilter },
  });

  const totals = (latestRun?.totals ?? null) as {
    netPaise?: number;
    paidPaise?: number;
    outstandingPaise?: number;
  } | null;

  // One person's own month, counted by the same function `/attendance` and the
  // payslip trace read. Counting it separately here would work, and would
  // eventually disagree with those two with no way to say which was right.
  //
  // Only when their attendance is theirs to read: `getMonthlyGrid` resolves
  // the `attendance.read` scope and refuses when there is none. With "See
  // their own attendance" revoked the tiles simply have nothing to say.
  const [yearStr, monthStr] = today.split("-");
  const canReadOwnAttendance = resolveScope(ctx.permissions, "attendance.read") !== null;
  const myMonth =
    scope === "self" && ctx.employeeId && canReadOwnAttendance
      ? await (async () => {
          const grid = await getMonthlyGrid(ctx, {
            year: Number(yearStr),
            month: Number(monthStr),
            employeeId: ctx.employeeId!,
          });
          const t = grid.rows[0]?.totals;
          if (!t) return null;
          return {
            label: grid.label,
            present: t.present,
            absent: t.absent,
            halfDays: t.halfDays,
            leave: t.leave,
            weekOff: t.weekOff,
            holiday: t.holiday,
            // Derived rather than counted, so it cannot drift from the days
            // above: everything in the month that was not a rest day.
            workingDays: grid.dates.length - t.weekOff - t.holiday,
          };
        })()
      : null;

  return {
    today,
    scope,
    myMonth,
    headcount: { total, active, onNotice, inTraining },
    attendance: {
      present,
      late: lateToday,
      absent: byStatus(["ABSENT"]),
      onLeave: byStatus(["PAID_LEAVE", "UNPAID_LEAVE"]),
      // Anyone with no row at all today, minus those on a rest day.
      notMarked: Math.max(0, active - marked),
    },
    seats: summariseSeats(ctx.organization?.seats ?? 0, ctx.organization?.activeEmployees ?? 0),
    pending: {
      leaveRequests: pendingLeave,
      documentDeletions: pendingDeletions,
      regularisations: pendingRegularisations,
      reimbursements: pendingReimbursements,
    },
    payroll: {
      latest: latestRun
        ? {
            year: latestRun.periodYear,
            month: latestRun.periodMonth,
            status: latestRun.status,
            netPaise: totals?.netPaise ?? 0,
            paidPaise: totals?.paidPaise ?? 0,
            outstandingPaise: totals?.outstandingPaise ?? 0,
            employees: latestRun._count.items,
          }
        : null,
    },
    upcomingHolidays: holidays.map((h) => ({
      id: h.id,
      name: h.name,
      date: h.date.toISOString().slice(0, 10),
    })),
    announcements: announcements.map((a) => ({
      id: a.id,
      title: a.title,
      publishAt: a.publishAt,
      authorName: a.author.name,
    })),
  };
}

// ------------------------------------------------------------------ platform

export interface PlatformDashboard {
  organisations: { total: number; active: number; suspended: number; trial: number };
  users: { total: number; employees: number };
  revenue: { mrrPaise: number; collectedPaise: number; pendingPaise: number; paidSeats: number };
  queues: { pendingPayments: number; passwordResets: number; expiringSoon: number };
  recentPayments: {
    id: string;
    orderNumber: string;
    organizationName: string;
    userCount: number;
    payablePaise: number;
    status: string;
    createdAt: Date;
  }[];
}

export async function getPlatformDashboard(): Promise<PlatformDashboard> {
  const soon = new Date(Date.now() + 14 * 86_400_000);

  const [
    orgCounts,
    subscriptions,
    userCount,
    employeeCount,
    approvedOrders,
    pendingOrders,
    resetCount,
    expiringSoon,
    recent,
  ] = await Promise.all([
    prisma.organization.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.subscription.findMany({
      select: { seats: true, pricePerUserPaise: true, billingMode: true },
    }),
    prisma.user.count(),
    prisma.employee.count(),
    prisma.paymentOrder.aggregate({
      where: { status: "APPROVED" },
      _sum: { payablePaise: true, userCount: true },
    }),
    prisma.paymentOrder.aggregate({
      where: { status: { in: ["AWAITING_CONFIRMATION", "INFO_REQUESTED"] } },
      _sum: { payablePaise: true },
      _count: { _all: true },
    }),
    prisma.passwordResetRequest.count({ where: { status: "PENDING" } }),
    prisma.subscription.count({
      where: { billingMode: { not: "FREE_INTERNAL" }, currentPeriodEnd: { lte: soon } },
    }),
    prisma.paymentOrder.findMany({
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        orderNumber: true,
        userCount: true,
        payablePaise: true,
        status: true,
        createdAt: true,
        organization: { select: { name: true } },
      },
    }),
  ]);

  const count = (status: string) =>
    orgCounts.find((row) => row.status === status)?._count._all ?? 0;

  return {
    organisations: {
      total: orgCounts.reduce((sum, row) => sum + row._count._all, 0),
      active: count("ACTIVE"),
      suspended: count("SUSPENDED"),
      trial: subscriptions.filter((s) => s.billingMode === "TRIAL").length,
    },
    users: { total: userCount, employees: employeeCount },
    revenue: {
      mrrPaise: computeMrr(subscriptions),
      collectedPaise: approvedOrders._sum.payablePaise ?? 0,
      pendingPaise: pendingOrders._sum.payablePaise ?? 0,
      paidSeats: approvedOrders._sum.userCount ?? 0,
    },
    queues: {
      pendingPayments: pendingOrders._count._all,
      passwordResets: resetCount,
      expiringSoon,
    },
    recentPayments: recent.map((r) => ({
      id: r.id,
      orderNumber: r.orderNumber,
      organizationName: r.organization.name,
      userCount: r.userCount,
      payablePaise: r.payablePaise,
      status: r.status,
      createdAt: r.createdAt,
    })),
  };
}
