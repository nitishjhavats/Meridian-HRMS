import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { asNotFound } from "@/lib/auth/notFound";
import { getExit } from "@/services/exit";
import { PageHeader, Section } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { ExitDetail, type ExitDetailData } from "./ExitDetail";

export const metadata = { title: "Exit" };
export const dynamic = "force-dynamic";

export default async function ExitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "exit.manage", module: "exit", what: "exits" });
  if (denied) return denied;

  const { id } = await params;
  const record = await getExit(ctx, id).catch(asNotFound);

  return (
    <>
      <Link
        href="/exit"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Exits
      </Link>

      <PageHeader
        title={record.employee.name}
        description={`${record.employee.employeeCode} · ${record.type.replaceAll("_", " ").toLowerCase()}`}
        action={<Badge tone="primary">{record.status.replaceAll("_", " ").toLowerCase()}</Badge>}
      />

      <div className="mb-4">
        <Section title="The dates" description="What the settlement is calculated from">
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-3 p-4 sm:grid-cols-4">
            {[
              ["Joined", record.employee.joiningDate ? formatDate(record.employee.joiningDate) : "—"],
              ["Resigned", formatDate(record.resignationDate)],
              ["Last working day", formatDate(record.lastWorkingDay)],
              [
                "Notice",
                `${record.noticeDaysServed} of ${record.noticeDaysRequired} days` +
                  (record.noticeShortfallDays > 0 ? ` · ${record.noticeShortfallDays} short` : ""),
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {record.reason ? (
            <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
              {record.reason}
            </p>
          ) : null}
        </Section>
      </div>

      <ExitDetail
        exit={record as unknown as ExitDetailData}
        canSettle={ctx.permissions.has("exit.settle")}
      />
    </>
  );
}
