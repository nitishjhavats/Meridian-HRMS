import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { getLeaveBalances, listLeaveRequests, listLeaveTypes } from "@/services/leave";
import { PageHeader, Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { RequestLeave } from "./RequestLeave";
import { MyRequests, type LeaveRow } from "./MyRequests";

export const metadata = { title: "My leave" };
export const dynamic = "force-dynamic";

export default async function MyLeavePage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    ownEmployeeRecord: true,
    // Seeing your own leave and balances is not the same right as applying for
    // it; the apply action inside the page asks for `leave.request`.
    permission: "leave.read.self",
    module: "leave",
    what: "your leave",
  });
  if (denied) return denied;

  if (!ctx.employeeId) {
    return (
      <>
        <PageHeader title="My leave" />
        <Alert tone="info" title="No employee record">
          Your login is not linked to an employee record yet, so there is no leave to show. Ask HR
          to connect them.
        </Alert>
      </>
    );
  }

  // The types list exists for the apply form, and `listLeaveTypes` asks for
  // `leave.request` the way applying does. With that revoked -- a contractor
  // who must not apply, say -- the page threw on it and showed nothing, not
  // even the balances the guard above says they may see.
  const canRequest = ctx.permissions.has("leave.request");
  const [balances, requests, types] = await Promise.all([
    getLeaveBalances(ctx, ctx.employeeId),
    listLeaveRequests(ctx, { employeeId: ctx.employeeId }),
    canRequest ? listLeaveTypes(ctx) : Promise.resolve([]),
  ]);

  return (
    <>
      <PageHeader title="My leave" description="Your balances, and everything you have asked for." />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-4">
          {canRequest ? (
            <RequestLeave types={types} />
          ) : (
            <Alert tone="info" title="Applying for leave is switched off for your login">
              You can see your balances and requests here. Ask an administrator if you think you
              should be able to apply.
            </Alert>
          )}

          <Section title="Balances" description="After deducting anything still pending">
            <ul className="divide-y divide-border">
              {balances.map((b) => (
                <li key={b.leaveTypeId} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: b.color }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{b.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {b.used} used
                      {b.pending > 0 ? ` · ${b.pending} pending` : ""}
                      {b.carriedForward > 0 ? ` · ${b.carriedForward} carried over` : ""}
                    </p>
                  </div>
                  <span className="tabular shrink-0 text-sm font-semibold">
                    {b.paid ? b.available : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        </div>

        <Section title="Your requests" description="Newest first">
          <MyRequests requests={requests as LeaveRow[]} />
        </Section>
      </div>
    </>
  );
}
