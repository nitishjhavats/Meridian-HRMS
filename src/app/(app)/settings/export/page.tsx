import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { PageHeader } from "@/components/ui/stat";
import { listExports } from "@/services/export";
import { ExportPanel } from "./ExportPanel";

export const metadata = { title: "Data export" };
export const dynamic = "force-dynamic";

export default async function ExportPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "org.data.export", what: "data exports" });
  if (denied) return denied;

  const jobs = await listExports(ctx);

  return (
    <>
      <Link
        href="/settings"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Settings
      </Link>

      <PageHeader
        title="Data export"
        description="Everything this organisation holds, in one encrypted archive."
      />

      {/* The support view may look at the list; `requestExport` refuses it a
          build, so the button is disabled here rather than left to fail. */}
      <ExportPanel jobs={jobs} readOnly={ctx.readOnlyView} />

      <div className="mt-4 space-y-2 text-xs text-muted-foreground">
        <p className="flex gap-1.5">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
          <span>
            The archive is encrypted with a password shown once and stored nowhere you can read it
            without asking. A copy of the file on its own cannot be opened. Exports are deleted
            automatically after 48 hours.
          </span>
        </p>
        <p className="pl-5">
          Statutory identifiers, bank details and authentication secrets are <em>not</em> included —
          they are encrypted in the database and are exported as “[redacted]”. Uploaded files appear
          as their metadata; the bytes stay on the server.
        </p>
      </div>
    </>
  );
}
