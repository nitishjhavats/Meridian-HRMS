import { Clock } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { getTodayStatus } from "@/services/attendance/checkIn";
import { prisma } from "@/lib/db/prisma";
import { PageHeader, Section } from "@/components/ui/stat";
import { MonthDetail } from "@/components/attendance/MonthDetail";
import { Badge } from "@/components/ui/badge";
import { Alert, EmptyState } from "@/components/ui/states";
import { ResponsiveList, TBody, TD, TH, THead, TR, Table, TableWrap } from "@/components/ui/table";
import { formatDate, formatDuration, formatTime } from "@/lib/utils";
import { todayInZone } from "@/domain/date";
import { STATUS_LABELS } from "@/domain/attendance/policy";
import { listRegularisations } from "@/services/attendance/regularisation";
import { myFlaggedDays } from "@/services/attendance/review";
import { CheckInPanel } from "./CheckInPanel";
import { InReview } from "./InReview";
import { RegularisePanel, type MyRegularisation } from "./RegularisePanel";

export const metadata = { title: "My attendance" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral" | "info"> = {
  FULL_DAY: "success",
  TRAINING_DAY: "success",
  EXTRA_DAY: "info",
  HALF_DAY: "warning",
  PAID_LEAVE: "info",
  UNPAID_LEAVE: "warning",
  ABSENT: "danger",
  WEEK_OFF: "neutral",
  HOLIDAY: "neutral",
  NOT_MARKED: "neutral",
  // In progress, not a verdict: today's row while the person is still at work.
  CHECKED_IN: "info",
};

export default async function MyAttendancePage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    ownEmployeeRecord: true,
    // Reading, not marking. `attendance.read.self` was declared, granted and
    // gated nothing, while this page asked for `attendance.mark.self` — so an
    // organisation that moves to office-device-only, where somebody may see
    // their attendance but not mark it, had no way to express that at all.
    permission: "attendance.read.self",
    module: "attendance",
    what: "your attendance",
  });
  if (denied) return denied;

  const timezone = ctx.organization?.timezone ?? "Asia/Kolkata";

  // The check-in panel is for somebody who may mark from their own device.
  // `getTodayStatus` asks for `attendance.mark.self` the same way
  // `markAttendance` does, so with that revoked -- the office-device-only case
  // the guard above exists for -- calling it threw the whole page into the
  // error boundary, history and corrections included. Skip it and say why
  // there is no button instead.
  const canMark = ctx.permissions.has("attendance.mark.self");
  const today = canMark ? await getTodayStatus(ctx) : null;
  const todayDate = today?.date ?? todayInZone(timezone);

  const history = await prisma.attendanceDay.findMany({
    where: { employeeId: ctx.employeeId! },
    orderBy: { date: "desc" },
    take: 30,
    select: {
      id: true,
      date: true,
      status: true,
      firstCheckInAt: true,
      lastCheckOutAt: true,
      workedMinutes: true,
      lateMinutes: true,
      overriddenAt: true,
    },
  });

  // Their own corrections only — `mine` scopes to the caller's employee id.
  const [regularisations, flagged] = await Promise.all([
    ctx.permissions.has("attendance.regularise.request")
      ? listRegularisations(ctx, { mine: true })
      : Promise.resolve([]),
    // Their own unconfirmed marks. Shown here rather than only as a toast at the
    // moment of marking, which is a message nobody can go back and read.
    myFlaggedDays(ctx),
  ]);

  return (
    <>
      {/* Two buttons rather than a row of tiles: the counts matter on the day
          somebody disputes a payslip, and are furniture on every other day. */}
      <PageHeader
        title="My attendance"
        description={formatDate(todayDate)}
        action={<MonthDetail />}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,420px)_1fr] lg:items-start">
        <div className="space-y-4">
          {today ? (
            <CheckInPanel
              initial={{
                ...today,
                checkedInAt: today.checkedInAt?.toISOString() ?? null,
                checkedOutAt: today.checkedOutAt?.toISOString() ?? null,
              }}
            />
          ) : (
            <Alert tone="info" title="Attendance is marked at the office">
              Your login can see your attendance but not mark it from this device. Use the office
              device, or ask an administrator if you think this is wrong.
            </Alert>
          )}

          <InReview initial={flagged} />

          {ctx.permissions.has("attendance.regularise.request") ? (
            <Section
              title="Something wrong with a day?"
              description="Ask for it to be corrected rather than chasing someone"
            >
              <RegularisePanel requests={regularisations as MyRegularisation[]} />
            </Section>
          ) : null}
        </div>

        <Section title="Last 30 days" description="Your own record, as payroll will read it.">
          {/**
            * Cards on a phone, which is where this screen is read.
            *
            * Five columns inside a sideways scroll, on the one page an
            * employee opens on their own device to check their own record --
            * "what time did I get in on the 3rd" needed two hands and a swipe.
            */}
          <ResponsiveList
            items={history}
            empty={<EmptyState icon={Clock} title="Nothing recorded yet" />}
            head={
              <>
                <TH>Date</TH>
                <TH>In</TH>
                <TH>Out</TH>
                <TH>Worked</TH>
                <TH>Status</TH>
              </>
            }
            row={(day) => (
              <TR key={day.id}>
                <TD className="whitespace-nowrap">{formatDate(day.date)}</TD>
                <TD>
                  {day.firstCheckInAt ? formatTime(day.firstCheckInAt, timezone) : "—"}
                  {day.lateMinutes > 0 ? (
                    <span className="block text-xs text-warning-text">
                      {day.lateMinutes} min late
                    </span>
                  ) : null}
                </TD>
                <TD>{day.lastCheckOutAt ? formatTime(day.lastCheckOutAt, timezone) : "—"}</TD>
                <TD className="tabular">
                  {day.workedMinutes > 0 ? formatDuration(day.workedMinutes) : "—"}
                </TD>
                <TD>
                  <Badge tone={STATUS_TONE[day.status] ?? "neutral"}>
                    {STATUS_LABELS[day.status] ?? day.status}
                  </Badge>
                  {day.overriddenAt ? (
                    <span className="block text-xs text-muted-foreground">adjusted by admin</span>
                  ) : null}
                </TD>
              </TR>
            )}
            card={(day) => (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{formatDate(day.date)}</p>
                  <p className="text-xs text-muted-foreground">
                    {day.firstCheckInAt ? formatTime(day.firstCheckInAt, timezone) : "—"}
                    {" – "}
                    {day.lastCheckOutAt ? formatTime(day.lastCheckOutAt, timezone) : "—"}
                    {day.workedMinutes > 0 ? ` · ${formatDuration(day.workedMinutes)}` : ""}
                  </p>
                  {day.lateMinutes > 0 ? (
                    <p className="text-xs text-warning-text">{day.lateMinutes} min late</p>
                  ) : null}
                  {day.overriddenAt ? (
                    <p className="text-xs text-muted-foreground">adjusted by admin</p>
                  ) : null}
                </div>
                <Badge tone={STATUS_TONE[day.status] ?? "neutral"}>
                  {STATUS_LABELS[day.status] ?? day.status}
                </Badge>
              </div>
            )}
          />
        </Section>
      </div>
    </>
  );
}
