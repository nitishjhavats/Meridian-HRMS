import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { isAiConfigured } from "@/lib/ai/openrouter";
import {
  defaultPeriod,
  getMonthlyEntry,
  getRecognitionSetup,
  previewCycle,
} from "@/services/recognition";
import { PageHeader } from "@/components/ui/stat";
import { ParameterEditor } from "./ParameterEditor";
import { MonthlyCycle } from "./MonthlyCycle";

export const metadata = { title: "Employee of the Month" };
export const dynamic = "force-dynamic";

/**
 * Where the month is set up, drafted and published.
 *
 * The month it opens on is the *previous* one, not the one in progress: a month
 * is scored once it is over and the figures are in, and landing on a half-finished
 * month invites publishing one.
 */
export default async function RecognitionSettingsPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "recognition.manage",
    module: "recognition",
    what: "Employee of the Month",
  });
  if (denied) return denied;

  const period = defaultPeriod(ctx);
  const [setup, entry, preview, aiAvailable] = await Promise.all([
    getRecognitionSetup(ctx),
    getMonthlyEntry(ctx, period.year, period.month),
    previewCycle(ctx, period.year, period.month),
    isAiConfigured(ctx.organizationId!),
  ]);

  return (
    <>
      <Link
        href="/recognition"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Employee of the Month
      </Link>

      <PageHeader
        title="Employee of the Month"
        description="Choose what it is decided on, enter the month's figures, check the arithmetic, then publish."
      />

      <div className="space-y-4">
        <ParameterEditor
          initial={setup}
          aiAvailable={aiAvailable && ctx.modules.has("ai")}
        />
        <MonthlyCycle
          initialPeriod={period}
          initialEntry={entry}
          initialPreview={preview}
          currency={ctx.organization?.currency ?? "INR"}
          aiAvailable={aiAvailable && ctx.modules.has("ai")}
        />
      </div>
    </>
  );
}
