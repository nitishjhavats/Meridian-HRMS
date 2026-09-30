import { requirePageContext } from "@/lib/auth/context";
import { listAuditLog } from "@/services/audit";
import { PageHeader, Section } from "@/components/ui/stat";
import { AuditTable } from "@/components/audit/AuditTable";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

export default async function PlatformAuditPage() {
  const ctx = await requirePageContext({ superadmin: true });
  const logs = await listAuditLog(ctx);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what, across every organisation. Secrets are redacted before a row is written."
      />
      <Section title="Recent activity" description="Most recent 200 events.">
        <AuditTable logs={logs} showOrganization />
      </Section>
    </>
  );
}
