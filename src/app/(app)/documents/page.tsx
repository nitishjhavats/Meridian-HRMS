import { requirePageContext } from "@/lib/auth/context";
import { employeeName } from "@/domain/employees/name";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { listDeletionRequests, listDocuments } from "@/services/documents";
import { PageHeader, Section, Stat, StatGrid } from "@/components/ui/stat";
import { DocumentList, DocumentUploader, type DocumentItem } from "../me/documents/DocumentList";
import { DeletionQueue, type DeletionRequest } from "./DeletionQueue";

export const metadata = { title: "Document vault" };
export const dynamic = "force-dynamic";

export default async function DocumentVaultPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    anyPermission: ["document.read.all", "document.read.team"],
    module: "documents",
    what: "the document vault",
  });
  if (denied) return denied;

  const canApproveDeletion = ctx.permissions.has("document.delete.approve");
  const canUploadAny = ctx.permissions.has("document.upload.any");

  const [documents, deletions, employees] = await Promise.all([
    listDocuments(ctx),
    canApproveDeletion ? listDeletionRequests(ctx) : Promise.resolve([]),
    canUploadAny
      ? prisma.employee.findMany({
          where: { organizationId: ctx.organizationId!, active: true },
          orderBy: { employeeCode: "asc" },
          select: { id: true, employeeCode: true, firstName: true, lastName: true, user: { select: { name: true } } },
        })
      : Promise.resolve([]),
  ]);

  const pending = documents.filter((d) => d.status === "PENDING_VERIFICATION");
  const expiring = documents.filter((d) => d.expiringSoon || d.expired);

  return (
    <>
      <PageHeader
        title="Document vault"
        description="Everything held on file for the people you are responsible for."
      />

      <div className="mb-4">
        <StatGrid>
          <Stat label="Documents" value={String(documents.length)} />
          <Stat label="Awaiting check" value={String(pending.length)} />
          <Stat label="Expiring or expired" value={String(expiring.length)} />
          <Stat label="Deletion requests" value={String(deletions.length)} />
        </StatGrid>
      </div>

      <DeletionQueue requests={deletions as DeletionRequest[]} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:items-start">
        {canUploadAny ? (
          <Section title="Add a document" description="Filed against any active employee">
            <DocumentUploader
              employeeId={null}
              employees={employees.map((e) => ({
                id: e.id,
                name: employeeName(e, "—"),
                code: e.employeeCode,
              }))}
            />
          </Section>
        ) : (
          <div />
        )}

        <div className="space-y-4">
          {pending.length > 0 ? (
            <Section title="Waiting to be checked" description="Newly uploaded or replaced">
              <DocumentList
                documents={pending as DocumentItem[]}
                abilities={{
                  canVerify: ctx.permissions.has("document.verify"),
                  canRequestDeletion: canApproveDeletion,
                  canUpload: canUploadAny,
                  showOwner: true,
                }}
              />
            </Section>
          ) : null}

          <Section title="All documents" description="Newest first">
            <DocumentList
              documents={documents as DocumentItem[]}
              abilities={{
                canVerify: ctx.permissions.has("document.verify"),
                canRequestDeletion: canApproveDeletion,
                canUpload: canUploadAny,
                showOwner: true,
              }}
            />
          </Section>
        </div>
      </div>
    </>
  );
}
