import Link from "next/link";
import {
  BadgeIndianRupee,
  CalendarDays,
  CheckCircle2,
  Circle,
  Clock,
  FileWarning,
  Megaphone,
  Trophy,
  UserCheck,
  UserRoundX,
  UserX,
  Users,
  Wallet,
} from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { hasPermission } from "@/lib/auth/guard";
import { assetsIssuedToMe } from "@/services/assets";
import { getOrgDashboard } from "@/services/dashboard";
import { getSetupState } from "@/services/org/setup";
import { getCurrentAward } from "@/services/recognition";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, EmptyState } from "@/components/ui/states";
import { formatDate, formatMoney, formatMoneyCompact, formatRelative, pluralise } from "@/lib/utils";
import { monthLabel } from "@/domain/date";
import { approvalRows, canOpen, canOpenOwn } from "./links";
import { MyAssets } from "./MyAssets";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/**
 * One route, six experiences.
 *
 * The tiles a person sees are the ones their permissions actually cover: a Team
 * Member gets their own day, a Team Lead their team, an Admin the organisation.
 * Nothing here is decided by role name — it is all permission checks, which is
 * what keeps the UI honest about what the API will allow.
 */
export default async function DashboardPage() {
  const ctx = await requirePageContext({ org: true });
  const [data, setup, award, myAssets] = await Promise.all([
    getOrgDashboard(ctx),
    getSetupState(ctx),
    // Everybody sees this one, so it is gated on the module and nothing else.
    ctx.modules.has("recognition") ? getCurrentAward(ctx) : Promise.resolve(null),
    // Their own record, so it needs one; and the module, like everything else.
    ctx.employeeId && ctx.modules.has("assets") ? assetsIssuedToMe(ctx) : Promise.resolve([]),
  ]);

  // Every link below is decided the way the sidebar decides an entry: the
  // permission, the module if one applies, and for a `/me` screen an employee
  // record to be about. See `links.ts` for why.
  const seesPeople = hasPermission(ctx, "employee.read.all") || hasPermission(ctx, "employee.read.team");
  // The figures the dashboard service returns are the whole organisation's, so
  // only the `.all` holder gets the tiles. A `.team` holder gets a way to the
  // payroll page, where the service narrows every figure to their reports.
  const seesPayroll = canOpen(ctx, "payroll.read.all", "payroll");
  const seesTeamPayroll = !seesPayroll && canOpen(ctx, "payroll.read.team", "payroll");
  const seesBilling = hasPermission(ctx, "org.billing.manage");
  const seesAnnouncements = canOpen(ctx, "announcement.read", "announcements");
  const isTeamScope = data.scope === "team";

  const ownAttendance = canOpenOwn(ctx, "attendance.read.self", "attendance");
  const ownLeave = canOpenOwn(ctx, "leave.read.self", "leave");
  const ownSalary = canOpenOwn(ctx, "payroll.read.self", "payroll");
  const ownDocuments = canOpenOwn(ctx, "document.read.self", "documents");
  const ownLinks = [ownAttendance, ownLeave, ownSalary, ownDocuments].some(Boolean);

  const approvals = approvalRows(ctx, data.pending);
  const pendingTotal = approvals.reduce((sum, row) => sum + row.count, 0);

  return (
    <>
      <PageHeader
        title={`Good day, ${ctx.name.split(" ")[0]}`}
        description={
          seesPeople
            ? `${isTeamScope ? "Your team" : ctx.organization?.name} · ${formatDate(data.today)}`
            : formatDate(data.today)
        }
      />

      {/* First-run setup. Absent for anybody who cannot act on it, and gone
          entirely once the last step is done — see `getSetupState`. */}
      {setup && setup.remaining > 0 ? (
        <div className="mb-4">
          <Section
            title="Finish setting up"
            description={`${setup.remaining} of ${setup.steps.length} left. Attendance and letters need these.`}
          >
            <ul className="divide-y divide-border">
              {setup.steps.map((step) => (
                <li key={step.key} className="flex items-start gap-3 px-4 py-3">
                  {step.done ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden />
                  ) : (
                    <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <Link
                      href={step.href}
                      className={
                        step.done
                          ? "text-sm text-muted-foreground line-through"
                          : "text-sm font-medium underline-offset-2 hover:underline"
                      }
                    >
                      {step.title}
                    </Link>
                    {!step.done ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">{step.why}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : null}

      {data.seats.overage > 0 && seesBilling ? (
        <div className="mb-4">
          <Alert tone="warning" title="You are over your seat limit">
            {pluralise(data.seats.used, "active employee")} against {data.seats.seats} seats.{" "}
            <Link href="/billing" className="underline underline-offset-2">
              Add seats
            </Link>{" "}
            to keep adding people.
          </Alert>
        </div>
      ) : null}

      {/* ---------- headline tiles ----------
          Two sets, because two different people are asking two different
          questions. Somebody with a team wants today across it. Somebody with
          only their own record wants their month — they were being shown their
          own attendance counted as a headcount, "Present today: 1", which is
          their data answering nobody's question. */}
      {data.myMonth ? (
        <StatGrid>
          <Stat
            label="Days present"
            value={data.myMonth.present}
            hint={`${data.myMonth.label} · ${data.myMonth.workingDays} working days`}
            icon={UserCheck}
            tone="success"
            href={ownAttendance ? "/me/attendance" : undefined}
          />
          <Stat
            label="Days absent"
            value={data.myMonth.absent}
            hint={data.myMonth.leave > 0 ? `${data.myMonth.leave} on leave` : undefined}
            icon={UserX}
            tone={data.myMonth.absent > 0 ? "danger" : "neutral"}
            href={ownAttendance ? "/me/attendance" : undefined}
          />
          <Stat
            label="Half days"
            value={data.myMonth.halfDays}
            icon={Clock}
            tone={data.myMonth.halfDays > 0 ? "warning" : "neutral"}
            href={ownAttendance ? "/me/attendance" : undefined}
          />
          <Stat
            label="Week offs"
            value={data.myMonth.weekOff}
            hint={data.myMonth.holiday > 0 ? `${data.myMonth.holiday} holidays besides` : undefined}
            icon={CalendarDays}
            tone="neutral"
            href={ownLeave ? "/me/leave" : undefined}
          />
        </StatGrid>
      ) : (
        <StatGrid>
          {seesPeople ? (
            <Stat
              label={isTeamScope ? "Team size" : "Active employees"}
              value={data.headcount.active}
              hint={data.headcount.inTraining > 0 ? `${data.headcount.inTraining} in training` : undefined}
              icon={Users}
              tone="primary"
              href="/employees"
            />
          ) : null}

          <Stat
            label="Present today"
            value={data.attendance.present}
            hint={data.attendance.late > 0 ? `${data.attendance.late} late` : "nobody late"}
            icon={UserCheck}
            tone="success"
            href={
              canOpen(ctx, ["attendance.read.all", "attendance.read.team"], "attendance")
                ? "/attendance"
                : ownAttendance
                  ? "/me/attendance"
                  : undefined
            }
          />

          <Stat
            label="On leave today"
            value={data.attendance.onLeave}
            icon={CalendarDays}
            tone="warning"
            href={
              canOpen(ctx, ["leave.read.all", "leave.read.team"], "leave")
                ? "/leave"
                : ownLeave
                  ? "/me/leave"
                  : undefined
            }
          />

          <Stat
            label="Absent today"
            value={data.attendance.absent}
            hint={data.attendance.notMarked > 0 ? `${data.attendance.notMarked} not marked` : undefined}
            icon={UserX}
            tone={data.attendance.absent > 0 ? "danger" : "neutral"}
            href={
              canOpen(ctx, ["attendance.read.all", "attendance.read.team"], "attendance")
                ? "/attendance"
                : undefined
            }
          />
        </StatGrid>
      )}

      {/* ---------- payroll + seats ---------- */}
      {seesPayroll || seesTeamPayroll || seesBilling ? (
        <div className="mt-3">
          <StatGrid>
            {seesTeamPayroll ? (
              <Stat
                label="Your team's payroll"
                value="Month by month"
                hint="Only the people who report to you"
                icon={BadgeIndianRupee}
                tone="primary"
                href="/payroll"
              />
            ) : null}

            {seesPayroll && data.payroll.latest ? (
              <>
                <Stat
                  label={`${monthLabel(data.payroll.latest.year, data.payroll.latest.month)} payroll`}
                  value={formatMoneyCompact(data.payroll.latest.netPaise)}
                  hint={`${formatMoney(data.payroll.latest.netPaise)} · ${data.payroll.latest.employees} employees`}
                  icon={Wallet}
                  tone="primary"
                  href="/payroll"
                />
                <Stat
                  label="Salary paid"
                  value={formatMoneyCompact(data.payroll.latest.paidPaise)}
                  icon={CheckCircle2}
                  tone="success"
                  href="/payroll"
                />
                <Stat
                  label="Still outstanding"
                  value={formatMoneyCompact(data.payroll.latest.outstandingPaise)}
                  icon={Clock}
                  tone={data.payroll.latest.outstandingPaise > 0 ? "warning" : "neutral"}
                  href="/payroll"
                />
              </>
            ) : null}

            {seesBilling ? (
              <Stat
                label="Seats used"
                value={`${data.seats.used} / ${data.seats.seats}`}
                hint={`${data.seats.utilisationPercent}% of your plan`}
                icon={Users}
                tone={data.seats.remaining === 0 ? "danger" : "neutral"}
                href="/billing"
              />
            ) : null}
          </StatGrid>
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-3">
        {/* ---------- approvals ---------- */}
        {seesPeople ? (
          <div className="lg:col-span-2">
            <Section
              title="Waiting for you"
              description={
                pendingTotal === 0 ? "Nothing needs your attention" : pluralise(pendingTotal, "pending item")
              }
            >
              {pendingTotal === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="All clear"
                  description="No approvals are pending right now."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {approvals.map((row) => (
                    <ApprovalRow
                      key={row.key}
                      href={row.href}
                      label={row.label}
                      count={row.count}
                      icon={APPROVAL_ICONS[row.key]}
                    />
                  ))}
                </ul>
              )}
            </Section>
          </div>
        ) : (
          <div className="lg:col-span-2">
            <Section title="Your day" description="Mark attendance and check your records">
              {ownLinks ? (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 p-4 sm:grid-cols-2">
                  {ownAttendance ? (
                    <QuickLink href="/me/attendance" icon={Clock} label="Check in / out" description="GPS and selfie verified" />
                  ) : null}
                  {ownLeave ? (
                    <QuickLink href="/me/leave" icon={CalendarDays} label="Apply for leave" description="See your balances" />
                  ) : null}
                  {ownSalary ? (
                    <QuickLink href="/me/salary" icon={Wallet} label="Salary slips" description="Download as PDF" />
                  ) : null}
                  {ownDocuments ? (
                    <QuickLink href="/me/documents" icon={FileWarning} label="My documents" description="Upload and track" />
                  ) : null}
                </div>
              ) : ctx.employeeId ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="Nothing to open from here"
                  description="Attendance, leave, salary and documents are either switched off for you or not part of your role. An administrator can change that."
                />
              ) : (
                // The same answer every `/me` page gives, given here instead of
                // after a click on a card that promised a payslip.
                <EmptyState
                  icon={UserRoundX}
                  title="Your login is not linked to an employee record"
                  description={
                    hasPermission(ctx, "employee.create")
                      ? "Attendance, leave and salary belong to an employee, and this login is not one yet. Add yourself to the employee directory and they will appear here."
                      : "Attendance, leave and salary belong to an employee, and this login is not one yet. Ask an administrator to add you to the employee directory."
                  }
                  action={
                    hasPermission(ctx, "employee.create") ? (
                      <Button asChild variant="secondary">
                        <Link href="/employees">Open the employee directory</Link>
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </Section>
          </div>
        )}

        {/* ---------- side column ---------- */}
        <div className="space-y-4">
          {myAssets.length > 0 ? <MyAssets initial={myAssets} /> : null}

          {award?.places[0] ? (
            <Section title="Employee of the Month" description={award.period.label}>
              <Link
                href="/recognition"
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
              >
                <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-warning-muted text-sm font-semibold text-warning-text">
                  {award.places[0].photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={award.places[0].photoUrl} alt="" className="size-full object-cover" />
                  ) : (
                    <Trophy className="size-4.5" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{award.places[0].name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {award.places[0].designation ?? award.places[0].employeeCode}
                  </span>
                </span>
                <Badge tone="warning">{award.places[0].totalScore.toFixed(0)}</Badge>
              </Link>
            </Section>
          ) : null}

          {seesAnnouncements ? (
            <Section title="Announcements">
              {data.announcements.length === 0 ? (
                <EmptyState icon={Megaphone} title="Nothing posted yet" />
              ) : (
                <ul className="divide-y divide-border">
                  {data.announcements.map((a) => (
                    <li key={a.id} className="px-4 py-3">
                      <Link href={`/announcements#${a.id}`} className="block hover:underline">
                        <p className="text-sm font-medium">{a.title}</p>
                      </Link>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {a.authorName} · {formatRelative(a.publishAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}

          <Section title="Upcoming holidays">
            {data.upcomingHolidays.length === 0 ? (
              <EmptyState icon={CalendarDays} title="No holidays scheduled" />
            ) : (
              <ul className="divide-y divide-border">
                {data.upcomingHolidays.map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="truncate text-sm">{h.name}</span>
                    <Badge tone="outline">{formatDate(h.date)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

const APPROVAL_ICONS = {
  leaveRequests: CalendarDays,
  regularisations: Clock,
  documentDeletions: FileWarning,
  reimbursements: Wallet,
} as const;

function ApprovalRow({
  href,
  label,
  count,
  icon: Icon,
}: {
  href: string;
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  if (count === 0) return null;
  return (
    <li>
      <Link href={href} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="flex-1 text-sm">{label}</span>
        <Badge tone="warning">{count}</Badge>
      </Link>
    </li>
  );
}

function QuickLink({
  href,
  icon: Icon,
  label,
  description,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/40"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-muted text-primary">
        <Icon className="size-4.5" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{description}</span>
      </span>
    </Link>
  );
}
