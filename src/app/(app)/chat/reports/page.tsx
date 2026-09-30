import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listReports } from "@/services/chat";
import { PageHeader } from "@/components/ui/stat";
import { ChatReports } from "./ChatReports";

export const metadata = { title: "Reported conversations" };
export const dynamic = "force-dynamic";

/**
 * What employees have reported.
 *
 * Gated on `chat.export` rather than a permission of its own: reading a
 * reported conversation *is* exporting it, and there should not be two
 * different ways to reach somebody's private messages.
 */
export default async function ChatReportsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "chat.export",
    module: "chat",
    what: "reported conversations",
  });
  if (denied) return denied;

  const reports = await listReports(ctx);

  return (
    <>
      <Link
        href="/chat"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Chat
      </Link>

      <PageHeader
        title="Reported conversations"
        description="Somebody asked you to look at these. Reading one means exporting it, which both people are told about."
      />

      <ChatReports initial={reports} />
    </>
  );
}
