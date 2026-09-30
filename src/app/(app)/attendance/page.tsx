import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { getMonthlyGrid } from "@/services/attendance/admin";
import { listRegularisations } from "@/services/attendance/regularisation";
import { todayInZone } from "@/domain/date";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { AttendanceGrid, type Grid } from "./AttendanceGrid";
import { RegularisationQueue, type RegularisationItem } from "./RegularisationQueue";
import { resolveMonthParam } from "./monthParam";

export const metadata = { title: "Attendance" };
export const dynamic = "force-dynamic";

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string; month?: string }>;
}) {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    anyPermission: ["attendance.read.all", "attendance.read.team"],
    module: "attendance",
    what: "attendance",
  });
  if (denied) return denied;

  const params = await searchParams;
  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  // A hand-edited `?month=13` falls back to this month rather than to the
  // error page; see `resolveMonthParam`.
  const { year, month } = resolveMonthParam(params, today);

  const [grid, requests] = await Promise.all([
    getMonthlyGrid(ctx, { year, month }),
    listRegularisations(ctx),
  ]);

  // Somebody else's, waiting on the viewer -- the viewer's own request shows
  // under history with its own label, the same as on the leave page.
  const pending = requests.filter(
    (r) => r.status === "PENDING" && r.employee.id !== ctx.employeeId,
  );

  // Summed across everyone shown, which is the number a manager plans around.
  const totals = grid.rows.reduce(
    (acc, row) => ({
      present: acc.present + row.totals.present,
      absent: acc.absent + row.totals.absent,
      late: acc.late + row.totals.lateCount,
      notMarked: acc.notMarked + row.totals.notMarked,
    }),
    { present: 0, absent: 0, late: 0, notMarked: 0 },
  );

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Everyone you are responsible for, a month at a time."
      />

      <div className="mb-4">
        <StatGrid>
          <Stat label="Present days" value={String(totals.present)} />
          <Stat label="Absent days" value={String(totals.absent)} />
          <Stat label="Late arrivals" value={String(totals.late)} />
          <Stat label="Corrections waiting" value={String(pending.length)} />
        </StatGrid>
      </div>

      {pending.length > 0 ? (
        <div className="mb-4">
          <Section
            title="Corrections waiting for a decision"
            description="Approving one applies the change to that day"
          >
            <RegularisationQueue
              requests={pending as RegularisationItem[]}
              canDecide={ctx.permissions.has("attendance.regularise.approve")}
              viewerEmployeeId={ctx.employeeId}
            />
          </Section>
        </div>
      ) : null}

      <Section title="Month grid" description="Click a day to correct it">
        <div className="p-4">
          <AttendanceGrid
            grid={grid as Grid}
            canOverride={ctx.permissions.has("attendance.override")}
          />
        </div>
      </Section>

      {requests.length > pending.length ? (
        <div className="mt-4">
          <Section title="Correction history" description="Already decided">
            <RegularisationQueue
              requests={requests.filter((r) => r.status !== "PENDING") as RegularisationItem[]}
              canDecide={false}
            />
          </Section>
        </div>
      ) : null}
    </>
  );
}
