import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listClaims, pendingPayouts } from "@/services/reimbursements";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { formatMoney } from "@/lib/utils";
import { Claims, type Claim } from "./Claims";

export const metadata = { title: "Reimbursements" };
export const dynamic = "force-dynamic";

export default async function ReimbursementsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    anyPermission: ["reimbursement.claim", "reimbursement.approve"],
    module: "reimbursements",
    what: "reimbursements",
  });
  if (denied) return denied;

  const canApprove = ctx.permissions.has("reimbursement.approve");
  const canClaim = ctx.permissions.has("reimbursement.claim") && Boolean(ctx.employeeId);

  const claims = await listClaims(ctx);
  // Approved and not yet reimbursed. Until this round nothing ever moved a claim
  // out of this list, because no approved claim had ever reached a payslip.
  const outstanding = canApprove ? await pendingPayouts(ctx) : [];
  const waiting = claims.filter((c) => c.status === "SUBMITTED");
  const approved = claims.filter((c) => c.status === "APPROVED");

  return (
    <>
      <PageHeader
        title="Reimbursements"
        description="Money already spent, claimed back with the bill attached."
      />

      <div className="mb-4">
        <StatGrid>
          <Stat label="Waiting" value={String(waiting.length)} />
          <Stat
            label="Claimed"
            value={`₹${(waiting.reduce((s, c) => s + c.totalPaise, 0) / 100).toLocaleString("en-IN")}`}
          />
          <Stat label="Approved, unpaid" value={String(approved.length)} />
          <Stat label="Paid" value={String(claims.filter((c) => c.status === "PAID").length)} />
        </StatGrid>
      </div>

      {canApprove && outstanding.length > 0 ? (
        <div className="mb-4">
          <Section
            title="Waiting to be paid"
            description="Approved and not yet reimbursed. Each is added to the payroll run for its month and marked paid when that run is locked."
          >
            <div className="space-y-2 p-4">
              <Alert
                tone="info"
                title={`${formatMoney(
                  outstanding.reduce((sum, c) => sum + c.approvedPaise, 0),
                )} owed across ${outstanding.length} claim${outstanding.length === 1 ? "" : "s"}`}
              >
                Anything approved after a month is locked rides with the next run rather than
                being missed.
              </Alert>
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {outstanding.map((claim) => (
                  <li key={claim.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {claim.employeeName}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {claim.claimNumber} · {claim.employeeCode}
                        {claim.period ? ` · pays with ${claim.period}` : ""}
                      </span>
                    </span>
                    <span className="tabular text-sm font-medium">
                      {formatMoney(claim.approvedPaise)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </Section>
        </div>
      ) : null}

      {canApprove && waiting.length > 0 ? (
        <div className="mb-4">
          <Section title="Waiting for you" description="Approve in full, in part, or decline">
            <div className="p-3">
              <Claims
                claims={waiting as Claim[]}
                canApprove={canApprove}
                canClaim={false}
              />
            </div>
          </Section>
        </div>
      ) : null}

      <Section title={canApprove ? "All claims" : "Your claims"} description="Newest first">
        <div className="p-3">
          <Claims claims={claims as Claim[]} canApprove={canApprove} canClaim={canClaim} />
        </div>
      </Section>

      <p className="mt-4 text-xs text-muted-foreground">
        An approved claim is paid with the next payroll run. Reimbursement is not salary — it is
        money already spent being returned — so it is never reduced by attendance.
      </p>
    </>
  );
}
