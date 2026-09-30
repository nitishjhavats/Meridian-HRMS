import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listModules } from "@/services/org/modules";
import { PageHeader } from "@/components/ui/stat";
import { ModuleToggles } from "./ModuleToggles";
import { ModuleScope } from "./ModuleScope";

export const metadata = { title: "Modules" };
export const dynamic = "force-dynamic";

export default async function ModulesSettingsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, { permission: "org.settings.read", what: "module settings" });
  if (denied) return denied;

  const modules = await listModules(ctx);

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
        title="Modules"
        description="Choose which parts of the product your organisation uses."
      />

      <ModuleToggles initial={modules} canWrite={ctx.permissions.has("org.modules.manage")} />

      {/* Below the organisation-wide switches, because it narrows them and can
          never widen them. */}
      <ModuleScope canWrite={ctx.permissions.has("org.modules.manage")} />
    </>
  );
}
