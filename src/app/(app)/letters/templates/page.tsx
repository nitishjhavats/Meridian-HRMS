import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { listFrameworks } from "@/services/letters/templates";
import { listEmployees } from "@/services/employees";
import { isAiConfigured } from "@/lib/ai/openrouter";
import { PLACEHOLDERS } from "@/domain/letters/template";
import { PageHeader } from "@/components/ui/stat";
import { TemplateManager } from "./TemplateManager";

export const metadata = { title: "Letter templates" };
export const dynamic = "force-dynamic";

/**
 * The frameworks every letter is issued from.
 *
 * `letter.template.manage` was declared when the permission list was written
 * and has gated nothing ever since, because this screen did not exist. So the
 * product shipped with `LetterTemplate` rows nothing could create, five columns
 * nothing read, and letters composed from a blank page every time.
 *
 * Reading is on `letter.issue` — anybody who issues letters should be able to
 * see what they are about to send — and only saving needs the manage permission.
 */
export default async function LetterTemplatesPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "letter.issue",
    module: "letters",
    what: "letter templates",
  });
  if (denied) return denied;

  const [frameworks, employees, aiAvailable] = await Promise.all([
    listFrameworks(ctx),
    listEmployees(ctx, {}),
    isAiConfigured(ctx.organizationId!),
  ]);

  return (
    <>
      <Link
        href="/letters"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Letters
      </Link>

      <PageHeader
        title="Letter templates"
        description="A default for every letter type. Edit the header, body or footer, preview it against a real person, and restore the original whenever you like."
      />

      <TemplateManager
        initial={frameworks}
        employees={employees.map((e) => ({
          id: e.id,
          name: e.name,
          employeeCode: e.employeeCode,
        }))}
        placeholders={[...PLACEHOLDERS]}
        canWrite={ctx.permissions.has("letter.template.manage")}
        aiAvailable={aiAvailable && ctx.modules.has("ai")}
        canSeePayslip={ctx.permissions.has("payroll.read.all") && ctx.modules.has("payroll")}
      />
    </>
  );
}
