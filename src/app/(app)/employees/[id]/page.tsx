import Link from "next/link";
import { ArrowLeft, Building2, CalendarDays, GraduationCap, MapPin, Trophy, Users } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { asNotFound } from "@/lib/auth/notFound";
import { hasPermission, teamEmployeeIds } from "@/lib/auth/guard";
import { assignableRoles, canManageRole, type SystemRole } from "@/lib/auth/permissions";
import { isEmployeeLoginRole } from "@/domain/employees/loginRoles";
import { getEmployee } from "@/services/employees";
import { livePrimaryLine } from "@/services/org/structure";
import { weeklyOffChoices } from "@/services/org/weeklyOff";
import { getEnrolmentStatus } from "@/services/employees/faceEnrolment";
import { getPayrollPolicy } from "@/services/policy";
import { awardCountsByEmployee } from "@/services/recognition";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { FaceEnrolment } from "@/components/employees/FaceEnrolment";
import { IssueAttendancePin } from "@/components/employees/IssueAttendancePin";
import { MonthDetail } from "@/components/attendance/MonthDetail";
import { EditEmployeeButton } from "../EmployeeForm";
import { EmploymentState } from "./EmploymentState";
import { LoginControls } from "./LoginControls";
import { SalaryRevision } from "./SalaryRevision";
import { WeekOffCard } from "./WeekOffCard";
import {
  describeWeeklyOff,
  readPersonalWeeklyOff,
  type WeeklyOffConfig,
} from "@/domain/calendar/weeklyOff";
import { formatDate, formatMoney, initials } from "@/lib/utils";

export const metadata = { title: "Employee" };

export const dynamic = "force-dynamic";

/** A `<input type="date">` wants YYYY-MM-DD; Prisma hands back a Date. */
function asDay(value: Date | string | null | undefined): string {
  if (!value) return "";
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

const STATE_TONE: Record<string, "success" | "info" | "warning" | "danger" | "neutral"> = {
  CONFIRMED: "success",
  REGULAR: "success",
  PROBATION: "info",
  TRAINING: "info",
  NOTICE_PERIOD: "warning",
  RESIGNED: "neutral",
  TERMINATED: "danger",
  INACTIVE: "neutral",
};

export default async function EmployeeProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    anyPermission: ["employee.read.all", "employee.read.team"],
    what: "employee records",
  });
  if (denied) return denied;


  // Every call that is scoped to what this person may see needs the same
  // handling, not just the first. `Promise.all` rejects with whichever settles
  // first, so leaving one unwrapped made the response 404 or 500 depending on a
  // race -- which is how it behaved after `getEnrolmentStatus` gained its own
  // scope check, and what the six-role sweep caught.
  const [employee, enrolment, awards, weekOffChoices, payroll] = await Promise.all([
    getEmployee(ctx, id).catch(asNotFound),
    getEnrolmentStatus(ctx, id).catch(asNotFound),
    // Empty unless the recognition module is on, so the badge simply does not appear.
    awardCountsByEmployee(ctx, [id]),
    // What "organisation default" actually is, and the patterns on offer.
    weeklyOffChoices(ctx),
    // The last layer a blank week-off quota falls through to. Only worth
    // reading where payroll will read it.
    ctx.modules.has("payroll") ? getPayrollPolicy(ctx) : Promise.resolve(null),
  ]);
  const awardsWon = awards[id] ?? 0;

  /**
   * The person's rest days, layer by layer, for the card and the summary row.
   *
   * Read through the same `readPersonalWeeklyOff` the resolver uses, so what
   * the profile calls "their own" is exactly what attendance, leave and
   * payroll will honour -- and a malformed column reads as "as the pattern
   * says" here as well as there.
   */
  const personalWeekOff = readPersonalWeeklyOff(employee.weeklyOffConfig);
  const patternConfig = employee.weeklyOffPattern
    ? (employee.weeklyOffPattern.config as unknown as WeeklyOffConfig)
    : null;
  const resolvedWeekOff = personalWeekOff ?? patternConfig ?? weekOffChoices.organisationDefault;
  const weekOffSummary = personalWeekOff
    ? describeWeeklyOff(personalWeekOff)
    : patternConfig
      ? describeWeeklyOff(patternConfig)
      : `Organisation default (${weekOffChoices.organisationDefaultSummary})`;

  const isSelf = ctx.employeeId === id;
  const canManageFace = hasPermission(ctx, "employee.update") || isSelf;
  // The module matters as much as the permission: `saveSalaryProfile` refuses
  // with payroll switched off, so offering the control there would be a button
  // whose only possible outcome is an error.
  // And never on your own record: setting your own pay is refused by the
  // service, so the control has no business appearing here.
  const canManageSalary =
    hasPermission(ctx, "employee.salary.manage") && ctx.modules.has("payroll") && !isSelf;
  // What `getEmployee` masks on: the figure is null either because there is no
  // revision or because this reader may not see it, and the two must not be
  // described the same way.
  const canSeeSalary = hasPermission(ctx, "employee.salary.read") || isSelf;
  const activeTraining = employee.trainingPlans.find(
    (p) => p.startDate <= new Date() && p.endDate >= new Date(),
  );

  // Every control below is offered only where the API would accept it. Each
  // of these used to be a button whose only possible outcome was a toast
  // saying no -- the six-role sweep clicked every one of them.

  const canEdit = hasPermission(ctx, "employee.update");
  // The live primary line, read by the same call `updateEmployee` reads it
  // with, so the edit dialog opens on the manager they actually have. Opened
  // on an empty field, the org-chart suggestion filled it in and a
  // phone-number fix reassigned them.
  const primaryLine = canEdit ? await livePrimaryLine(ctx, id) : null;
  // `changeEmploymentState` wants `employee.terminate` for the three leaving
  // states; HR Managers and Managers hold `employee.state.change` without it.
  const canTerminate = hasPermission(ctx, "employee.terminate");
  // The rank rule `createLoginForEmployee` and `resetEmployeePassword` apply:
  // nobody hands out, or resets, a role at or above their own -- which also
  // rules out your own record.
  const loginRoles = assignableRoles(ctx.role).filter(isEmployeeLoginRole);
  const canResetPassword =
    employee.user != null && !isSelf && canManageRole(ctx.role, employee.user.role as SystemRole);
  // The two ways into `issueAttendancePin`, and its one refusal: the
  // permission (folded in from the PIN authority rows when the context is
  // built) or the person's own reporting line -- and never for yourself,
  // because a PIN marks attendance with no photo at all.
  const canIssuePin =
    !isSelf &&
    (hasPermission(ctx, "attendance.pin.issue") || (await teamEmployeeIds(ctx)).includes(id));

  return (
    <>
      <Link
        href="/employees"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        All employees
      </Link>

      <PageHeader
        title={employee.name}
        description={`${employee.employeeCode}${
          employee.designation ? ` · ${employee.designation.title}` : ""
        }${employee.department ? ` · ${employee.department.name}` : ""}`}
        action={
          <span className="flex flex-wrap items-center gap-2">
            {awardsWon > 0 ? (
              <Link href="/recognition">
                <Badge tone="warning" title="Employee of the Month">
                  <Trophy className="size-3" aria-hidden />
                  {awardsWon}× Employee of the Month
                </Badge>
              </Link>
            ) : null}
            <Badge tone={STATE_TONE[employee.employmentState] ?? "neutral"}>
              {employee.employmentState.replaceAll("_", " ").toLowerCase()}
            </Badge>
            {/**
              * The calendar and the month totals, where somebody would look
              * for them.
              *
              * They were built, and they were mounted in the corner of the
              * "Attendance verification" card two thirds of the way down the
              * page — so the answer to "wo v nahi hai" was that they existed
              * and could not be found. A control nobody finds is a control
              * nobody has.
              */}
            <MonthDetail employeeId={employee.id} name={employee.name} />
            {canEdit ? (
              <EditEmployeeButton
                employee={{
                  id: employee.id,
                  employeeCode: employee.employeeCode,
                  firstName: employee.firstName,
                  lastName: employee.lastName ?? "",
                  // The form's date inputs want YYYY-MM-DD, not a Date.
                  joiningDate: asDay(employee.joiningDate),
                  dateOfBirth: asDay(employee.dateOfBirth),
                  workEmail: employee.workEmail ?? "",
                  // Letters fall back to this when there is no work email, so
                  // it has to be editable from the same place the rest of the
                  // letter's facts are.
                  personalEmail: employee.personalEmail ?? "",
                  phone: employee.phone ?? "",
                  gender: employee.gender ?? "",
                  employmentType: employee.employmentType,
                  // Both of these used to be left out, and the form filled the
                  // gap from its own defaults -- so the dialog opened claiming
                  // a permanent employee was on probation, and saving a changed
                  // name sent `confirmationDate: null` and destroyed the date
                  // their probation and their letters depend on.
                  employmentState: employee.employmentState,
                  confirmationDate: asDay(employee.confirmationDate),
                  workMode: employee.workMode,
                  departmentId: employee.department?.id ?? "",
                  designationId: employee.designation?.id ?? "",
                  workLocationId: employee.workLocation?.id ?? "",
                  shiftId: employee.shift?.id ?? "",
                  weeklyOffPatternId: employee.weeklyOffPattern?.id ?? "",
                  reportsToEmployeeId: primaryLine?.managerId ?? "",
                  allowSelfMarking:
                    employee.allowSelfMarking == null ? "" : employee.allowSelfMarking ? "yes" : "no",
                }}
              />
            ) : null}
            {hasPermission(ctx, "employee.state.change") ? (
              <EmploymentState
                employeeId={employee.id}
                name={employee.name}
                current={employee.employmentState}
                canTerminate={canTerminate}
              />
            ) : null}
            {canEdit && (!employee.user || canResetPassword) ? (
              <LoginControls
                employeeId={employee.id}
                name={employee.name}
                hasLogin={Boolean(employee.user)}
                hasEmail={Boolean(employee.workEmail ?? employee.personalEmail)}
                assignableRoles={loginRoles}
              />
            ) : null}
          </span>
        }
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-3 lg:items-start">
        {/* ---------- identity ---------- */}
        <Section title="Profile">
          <div className="p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-muted text-lg font-semibold text-primary">
                {employee.photoUrl ?? employee.facePhotoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={(employee.photoUrl ?? employee.facePhotoUrl)!}
                    alt=""
                    className="size-full object-cover"
                  />
                ) : (
                  initials(employee.name)
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate font-medium">{employee.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {employee.workEmail ?? employee.personalEmail ?? "—"}
                </p>
                {employee.phone ? (
                  <p className="text-sm text-muted-foreground">{employee.phone}</p>
                ) : null}
              </div>
            </div>

            <dl className="mt-4 space-y-2 text-sm">
              <Row icon={CalendarDays} label="Joined" value={formatDate(employee.joiningDate)} />
              <Row
                icon={Building2}
                label="Employment"
                value={`${employee.employmentType.replaceAll("_", " ").toLowerCase()} · ${employee.workMode.toLowerCase()}`}
              />
              <Row
                icon={MapPin}
                label="Work location"
                value={
                  employee.workLocation
                    ? `${employee.workLocation.name} (${employee.workLocation.radiusMeters} m radius)`
                    : "Not set"
                }
              />
              <Row icon={CalendarDays} label="Weekly off" value={weekOffSummary} />
              <Row
                icon={Users}
                label="Reports to"
                value={
                  employee.managers.length > 0
                    ? employee.managers
                        .map(
                          (m) =>
                            `${[m.manager.firstName, m.manager.lastName].filter(Boolean).join(" ")} (${m.type.toLowerCase()})`,
                        )
                        .join(", ")
                    : "Nobody"
                }
              />
            </dl>
          </div>
        </Section>

        {/* ---------- face verification ---------- */}
        <Section
          title="Attendance verification"
          description="Used to confirm the person marking attendance is who they say they are."
          // Where somebody already is when they open this person's face record:
          // the next question after "does their face match" is almost always
          // "what has this month looked like for them".
        >
          <FaceEnrolment
            employeeId={employee.id}
            employeeName={employee.name}
            enrolled={enrolment.enrolled}
            enrolledAt={enrolment.enrolledAt}
            photoUrl={employee.facePhotoUrl}
            engineAvailable={enrolment.engineAvailable}
            canManage={canManageFace}
            isSelf={isSelf}
          />

          {/* Beside the enrolment, because the two are the same conversation:
              this is what to do when the face on file will not do today. */}
          {canIssuePin ? (
            <div className="border-t border-border p-4">
              <IssueAttendancePin employeeId={employee.id} employeeName={employee.name} />
            </div>
          ) : null}
        </Section>

        {/* ---------- employment & pay ---------- */}
        <div className="space-y-4">
          {activeTraining ? (
            <Section title="Training">
              <div className="p-4">
                <p className="flex items-center gap-2 text-sm">
                  <GraduationCap className="size-4 shrink-0 text-primary" aria-hidden />
                  {formatDate(activeTraining.startDate)} → {formatDate(activeTraining.endDate)}
                </p>
                <p className="mt-1.5 text-sm text-muted-foreground">
                  {activeTraining.mode === "PERCENT"
                    ? `Paid at ${Number(activeTraining.percent ?? 0)}% of full salary`
                    : activeTraining.mode === "FIXED"
                      ? `Fixed stipend of ${formatMoney(activeTraining.fixedAmountPaise ?? 0)}`
                      : "Unpaid training"}
                  . Becomes {activeTraining.postTrainingState.toLowerCase()} afterwards.
                </p>
              </div>
            </Section>
          ) : null}

          {/* Beside the pay, because it decides part of it: the quota is what
              an unused rest day is paid against. Editing needs `employee.update`,
              the same right as the rest of the record; reading needs only what
              opened the page. */}
          <WeekOffCard
            employeeId={employee.id}
            name={employee.firstName}
            canEdit={canEdit}
            personalDays={personalWeekOff?.days ?? null}
            // The chips start from what they rest on today, so switching to
            // their own days is a tweak rather than a blank slate.
            seedDays={resolvedWeekOff.days ?? []}
            patternId={employee.weeklyOffPattern?.id ?? null}
            patterns={weekOffChoices.patterns}
            organisationDefaultSummary={weekOffChoices.organisationDefaultSummary}
            weekOffsPerMonth={employee.weekOffsPerMonth}
            designationQuota={employee.designation?.weekOffsPerMonth ?? null}
            policyQuota={payroll ? payroll.policy.weekOff.quotaPerMonth : undefined}
          />

          {employee.salary || canManageSalary ? (
            <Section
              title="Salary"
              action={
                canManageSalary ? (
                  <SalaryRevision employeeId={employee.id} name={employee.name} />
                ) : null
              }
            >
              <div className="p-4">
                {employee.salary ? (
                  <>
                    <p className="tabular text-xl font-semibold">
                      {formatMoney(employee.salary.ctcMonthlyPaise)}
                      <span className="text-sm font-normal text-muted-foreground"> / month</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Effective {formatDate(employee.salary.effectiveFrom)}
                    </p>
                  </>
                ) : canSeeSalary ? (
                  <p className="text-sm text-muted-foreground">
                    No salary has been recorded yet, so payroll would pay nothing.
                  </p>
                ) : (
                  // `employee.salary.manage` and `employee.salary.read` are
                  // separable now that individual permissions exist, and
                  // `getEmployee` masks the figure on the read permission
                  // alone. Saying "nothing recorded" here would be a lie that
                  // invites a second revision on top of a salary already in
                  // force.
                  <p className="text-sm text-muted-foreground">
                    You can record a salary here, but not read the one in force.
                  </p>
                )}
                {employee.identifiers ? (
                  <dl className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">PAN</dt>
                      <dd className="font-mono">{employee.identifiers.pan}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Aadhaar</dt>
                      <dd className="font-mono">{employee.identifiers.aadhaar}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Bank</dt>
                      <dd className="font-mono">{employee.identifiers.bankAccount}</dd>
                    </div>
                  </dl>
                ) : null}
              </div>
            </Section>
          ) : null}

          {employee.reports.length > 0 ? (
            <Section title={`Direct reports (${employee.reports.length})`}>
              <ul className="divide-y divide-border">
                {employee.reports.map((r) => (
                  <li key={r.employee.id}>
                    <Link
                      href={`/employees/${r.employee.id}`}
                      className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-muted/50"
                    >
                      <span>
                        {[r.employee.firstName, r.employee.lastName].filter(Boolean).join(" ")}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {r.employee.employeeCode}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {employee.stateHistory.length > 0 ? (
            <Section title="Employment history">
              <ul className="divide-y divide-border">
                {employee.stateHistory.map((change) => (
                  <li key={change.id} className="px-4 py-2.5 text-sm">
                    <span className="font-medium">
                      {change.fromState
                        ? `${change.fromState.toLowerCase()} → ${change.toState.toLowerCase()}`
                        : change.toState.toLowerCase()}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDate(change.effectiveOn)}
                      {change.reason ? ` · ${change.reason}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : (
            <Section title="Employment history">
              <EmptyState icon={CalendarDays} title="No changes recorded" />
            </Section>
          )}
        </div>
      </div>
    </>
  );
}

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="truncate">{value}</dd>
      </div>
    </div>
  );
}
