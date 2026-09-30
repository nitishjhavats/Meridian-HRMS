import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { PageHeader } from "@/components/ui/stat";
import { ChatScreen } from "./ChatScreen";

export const metadata = { title: "Chat" };
export const dynamic = "force-dynamic";

/**
 * Employee-to-employee messaging.
 *
 * Gated on the module *and* on `chat.use`, which everybody has by default —
 * the permission exists so an organisation can take chat away from one person
 * without switching it off for the whole company.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ with?: string }>;
}) {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "chat.use", module: "chat", what: "chat" });
  if (denied) return denied;

  const { with: openWith } = await searchParams;

  return (
    <>
      {/* No description. The same two sentences were on this header, in the
          list, under the composer and in the empty state -- four times on one
          screen. They are said once now, where somebody reads them before they
          start typing. */}
      <PageHeader title="Chat" />
      <ChatScreen initialWith={openWith ?? null} />
    </>
  );
}
