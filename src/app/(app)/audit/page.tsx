import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listAuditLog } from "@/services/audit";
import { PageHeader, Section } from "@/components/ui/stat";
import { AuditTable } from "@/components/audit/AuditTable";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

export default async function OrgAuditPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "audit.read", what: "the audit log" });
  if (denied) return denied;

  const logs = await listAuditLog(ctx);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every consequential action in your organisation, and what changed."
      />
      <Section title="Recent activity" description="Most recent 200 events.">
        <AuditTable logs={logs} showOrganization={false} />
      </Section>
    </>
  );
}
