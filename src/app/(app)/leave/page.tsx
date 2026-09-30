import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listLeaveRequests } from "@/services/leave";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { ApprovalQueue, type QueueRow } from "./ApprovalQueue";

export const metadata = { title: "Leave requests" };
export const dynamic = "force-dynamic";

export default async function LeavePage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    anyPermission: ["leave.read.all", "leave.read.team"],
    module: "leave",
    what: "leave requests",
  });
  if (denied) return denied;

  const requests = (await listLeaveRequests(ctx)) as QueueRow[];
  // Somebody else's, waiting on the viewer. The viewer's own request sits in
  // the same list and used to be counted here as work for them to do.
  const pending = requests.filter(
    (r) => r.status === "PENDING" && r.employee.id !== ctx.employeeId,
  );
  const approved = requests.filter((r) => r.status === "APPROVED");

  // Days already committed for the rest of this month, which is the number
  // that actually affects whether a team can cover its work.
  const today = new Date().toISOString().slice(0, 10);
  const monthEnd = `${today.slice(0, 7)}-31`;
  const upcoming = approved.filter((r) => r.endDate >= today && r.startDate <= monthEnd);

  return (
    <>
      <PageHeader
        title="Leave requests"
        description="Everyone you are responsible for, newest first."
      />

      <div className="mb-4">
        <StatGrid>
          <Stat label="Awaiting you" value={String(pending.length)} />
          <Stat
            label="Days requested"
            value={String(pending.reduce((sum, r) => sum + r.totalDays, 0))}
          />
          <Stat label="Approved this month" value={String(upcoming.length)} />
          <Stat
            label="Days away this month"
            value={String(upcoming.reduce((sum, r) => sum + r.totalDays, 0))}
          />
        </StatGrid>
      </div>

      {pending.length > 0 ? (
        <div className="mb-4">
          <Section title="Waiting for a decision" description="Oldest requests first">
            <ApprovalQueue requests={pending} viewerEmployeeId={ctx.employeeId} />
          </Section>
        </div>
      ) : null}

      <Section title="All requests" description="Including decided ones">
        <ApprovalQueue requests={requests} viewerEmployeeId={ctx.employeeId} />
      </Section>
    </>
  );
}
