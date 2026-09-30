import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listDocuments } from "@/services/documents";
import { PageHeader, Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { DocumentList, DocumentUploader, type DocumentItem } from "./DocumentList";

export const metadata = { title: "My documents" };
export const dynamic = "force-dynamic";

export default async function MyDocumentsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    ownEmployeeRecord: true,
    permission: "document.read.self",
    module: "documents",
    what: "your documents",
  });
  if (denied) return denied;

  if (!ctx.employeeId) {
    return (
      <>
        <PageHeader title="My documents" />
        <Alert tone="info" title="No employee record">
          Your login is not linked to an employee record yet. Ask HR to connect them.
        </Alert>
      </>
    );
  }

  const documents = await listDocuments(ctx, { employeeId: ctx.employeeId });
  const canUpload = ctx.permissions.has("document.upload.self");

  return (
    <>
      <PageHeader
        title="My documents"
        description="What your organisation holds on file for you."
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:items-start">
        {canUpload ? (
          <Section title="Add a document" description="Compressed and stored securely">
            <DocumentUploader employeeId={ctx.employeeId} />
          </Section>
        ) : (
          <div />
        )}

        <Section title="On file" description="Newest first">
          <DocumentList
            documents={documents as DocumentItem[]}
            abilities={{
              canVerify: false,
              // An employee may ask; only HR may actually delete.
              canRequestDeletion: ctx.permissions.has("document.delete.request"),
              canUpload,
              showOwner: false,
            }}
          />
        </Section>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        You cannot delete a document yourself — ask, and someone in HR reviews it. Records that
        their subject can quietly remove are not records.
      </p>
    </>
  );
}
