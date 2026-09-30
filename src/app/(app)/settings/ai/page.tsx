import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { getAiConfig } from "@/services/ai/config";
import { PageHeader } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { AiSettingsForm } from "./AiSettingsForm";

export const metadata = { title: "AI settings" };
export const dynamic = "force-dynamic";

export default async function AiSettingsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "ai.config.manage", what: "AI settings" });
  if (denied) return denied;

  // Deliberately not `requireModule`: an admin who has switched AI off still
  // needs to reach this screen to see the key they saved and to switch it back
  // on. The write route enforces the module; reading it is harmless. The form
  // is told, so it locks what would be refused rather than letting the key be
  // typed and then not saved.
  const moduleLive = ctx.modules.has("ai");
  const config = await getAiConfig(ctx);

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
        title="AI settings"
        description="The key and model used for letter drafting and AI payroll setup."
      />

      {!moduleLive ? (
        <div className="mb-4">
          <Alert tone="warning" title="The AI module is switched off">
            These settings cannot be changed until it is on. Turn it on under{" "}
            <Link href="/settings/modules" className="underline underline-offset-2">
              Settings → Modules
            </Link>
            , then come back here. The key you saved is kept meanwhile, and the connection can
            still be tested.
          </Alert>
        </div>
      ) : null}

      <AiSettingsForm initial={config} moduleLive={moduleLive} />

      <p className="mt-4 flex gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        <span>
          The key is encrypted before it is stored and is never included in any response, audit
          entry or error message. AI output is always a draft — nothing it produces is applied
          until a person approves it.
        </span>
      </p>
    </>
  );
}
