import Link from "next/link";
import { ScanFace, Trophy, UserPlus, Users } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { hasPermission } from "@/lib/auth/guard";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listEmployees } from "@/services/employees";
import { awardCountsByEmployee } from "@/services/recognition";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { ResponsiveList, TD, TH, TR } from "@/components/ui/table";
import { formatDate, initials, pluralise } from "@/lib/utils";
import { ImportEmployees } from "./ImportEmployees";
import { AssignBranch } from "./AssignBranch";
import { EmployeeForm } from "./EmployeeForm";

export const metadata = { title: "Employees" };
export const dynamic = "force-dynamic";

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

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    anyPermission: ["employee.read.all", "employee.read.team", "employee.read.self"],
    what: "employee records",
  });
  if (denied) return denied;

  const params = await searchParams;
  const employees = await listEmployees(ctx, { search: params.q });
  // Empty unless the recognition module is on, so the badge simply does not appear.
  const awards = await awardCountsByEmployee(ctx, employees.map((e) => e.id));
  const scoped = !hasPermission(ctx, "employee.read.all");
  // The profile page admits `.all` and `.team` and nothing else. Somebody
  // holding only `employee.read.self` still reaches this page -- by URL, since
  // the nav hides it -- and sees exactly themselves; making that one row a
  // link to a page that says "You do not have access" is a dead end dressed
  // as a door.
  const canOpenProfile =
    hasPermission(ctx, "employee.read.all") || hasPermission(ctx, "employee.read.team");
  const unenrolled = employees.filter((e) => e.active && !e.faceEnrolled).length;

  return (
    <>
      <PageHeader
        title={scoped ? "My team" : "Employees"}
        description={`${pluralise(employees.length, "person")}${
          employees.filter((e) => e.billable).length !== employees.length
            ? ` · ${employees.filter((e) => e.billable).length} using a seat`
            : ""
        }`}
        action={
          hasPermission(ctx, "employee.create") ? (
            <span className="flex flex-wrap items-center gap-2">
              <AssignBranch
                people={employees.map((e) => ({
                  id: e.id,
                  name: e.name,
                  employeeCode: e.employeeCode,
                  active: e.active,
                  workLocation: e.workLocation,
                }))}
              />
              <ImportEmployees />
              <EmployeeForm />
            </span>
          ) : undefined
        }
      />

      {unenrolled > 0 && hasPermission(ctx, "employee.update") ? (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-warning bg-warning-muted px-3 py-2 text-sm text-warning-text">
          <ScanFace className="size-4 shrink-0" aria-hidden />
          <span>
            {pluralise(unenrolled, "active employee has", "active employees have")} no reference
            photo, so their attendance selfies cannot be verified.
          </span>
        </div>
      ) : null}

      <Section
        title="Directory"
        description={
          canOpenProfile
            ? "Open a profile to manage employment and verification."
            : "Your own record. Your attendance, leave and payslips are under My workspace."
        }
      >
        <ResponsiveList
          items={employees}
          empty={
            <EmptyState
              icon={Users}
              title="No employees yet"
              description="Add the first one to get started."
              action={
                hasPermission(ctx, "employee.create") ? (
                  <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    <UserPlus className="size-4" aria-hidden />
                    Employee creation arrives with the onboarding wizard
                  </span>
                ) : undefined
              }
            />
          }
          head={
            <>
              <TH>Employee</TH>
              <TH>Designation</TH>
              <TH>Department</TH>
              <TH>Reports to</TH>
              <TH>Joined</TH>
              <TH>Status</TH>
              <TH>Face</TH>
            </>
          }
          row={(e) => (
            <TR key={e.id}>
              <TD>
                <ProfileLink
                  id={e.id}
                  linked={canOpenProfile}
                  className={`flex items-center gap-2.5${canOpenProfile ? " hover:underline" : ""}`}
                >
                  <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-muted text-xs font-semibold text-primary">
                    {e.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={e.photoUrl} alt="" className="size-full object-cover" />
                    ) : (
                      initials(e.name)
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{e.name}</span>
                      <AwardCount count={awards[e.id] ?? 0} />
                    </span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {e.employeeCode}
                    </span>
                  </span>
                </ProfileLink>
              </TD>
              <TD className="text-sm">{e.designation ?? "—"}</TD>
              <TD className="text-sm">{e.department ?? "—"}</TD>
              <TD className="text-xs text-muted-foreground">
                {e.managers.length > 0 ? e.managers.join(", ") : "—"}
              </TD>
              <TD className="whitespace-nowrap text-xs">{formatDate(e.joiningDate)}</TD>
              <TD>
                <Badge tone={STATE_TONE[e.employmentState] ?? "neutral"}>
                  {e.employmentState.replaceAll("_", " ").toLowerCase()}
                </Badge>
              </TD>
              <TD>
                {e.faceEnrolled ? (
                  <Badge tone="success">enrolled</Badge>
                ) : (
                  <Badge tone="neutral">none</Badge>
                )}
              </TD>
            </TR>
          )}
          card={(e) => (
            <ProfileLink
              key={e.id}
              id={e.id}
              linked={canOpenProfile}
              className="flex items-center gap-3"
            >
              <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-muted text-sm font-semibold text-primary">
                {e.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={e.photoUrl} alt="" className="size-full object-cover" />
                ) : (
                  initials(e.name)
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{e.name}</span>
                  <AwardCount count={awards[e.id] ?? 0} />
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {e.designation ?? "—"}
                  {e.department ? ` · ${e.department}` : ""}
                </span>
              </span>
              <Badge tone={STATE_TONE[e.employmentState] ?? "neutral"}>
                {e.employmentState.replaceAll("_", " ").toLowerCase()}
              </Badge>
            </ProfileLink>
          )}
        />
      </Section>
    </>
  );
}

/**
 * A row's name, as a link to the profile only when that page would open.
 *
 * The profile guard admits `employee.read.all` and `.team`; this page also
 * admits `.self`. For the person who holds only the last, the row is their
 * own and the profile is refused, so it is rendered as plain text rather
 * than as a link whose destination says no.
 */
function ProfileLink({
  id,
  linked,
  className,
  children,
}: {
  id: string;
  linked: boolean;
  className: string;
  children: React.ReactNode;
}) {
  if (!linked) return <span className={className}>{children}</span>;
  return (
    <Link href={`/employees/${id}`} className={className}>
      {children}
    </Link>
  );
}

/** Times this person has been Employee of the Month. Absent when they never have. */
function AwardCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    // The trophy carries the whole meaning here — the visible text is only
    // "3×" — so it is labelled rather than hidden, or the badge reads as a bare
    // number with no idea what it counts.
    <Badge tone="warning" title={`Employee of the Month ${count} times`}>
      <Trophy className="size-3" role="img" aria-label="Employee of the Month" />
      {count}×
    </Badge>
  );
}
