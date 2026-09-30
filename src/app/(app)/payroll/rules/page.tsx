import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { requirePageContext } from "@/lib/auth/context";
import { pageGuard } from "@/lib/auth/pageGuard";
import { prisma } from "@/lib/db/prisma";
import { getPayrollPolicy } from "@/services/policy";
import { isAiConfigured } from "@/lib/ai/openrouter";
import { describePolicy } from "@/domain/payroll/analyze";
import { todayInZone } from "@/domain/date";
import { PageHeader, Section } from "@/components/ui/stat";
import { Alert } from "@/components/ui/states";
import { Statutory } from "./Statutory";
import { AiRuleBuilder } from "./AiRuleBuilder";
import { RuleEditor } from "./RuleEditor";
import { Simulator } from "./Simulator";

export const metadata = { title: "Payroll rules" };
export const dynamic = "force-dynamic";

export default async function PayrollRulesPage() {
  const ctx = await requirePageContext({ org: true });
  const denied = pageGuard(ctx, {
    permission: "payroll.rules.manage",
    module: "payroll",
    what: "payroll rules",
  });
  if (denied) return denied;

  const today = todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const [{ policy, isDefault, errors }, aiConfigured, leaveTypes] = await Promise.all([
    getPayrollPolicy(ctx, today),
    ctx.modules.has("ai") ? isAiConfigured(ctx.organizationId!) : Promise.resolve(false),
    // For the comp-off field, which was a free-text box: a code matching no
    // leave type is not refused anywhere downstream -- `creditCompOff` skips
    // the credit and stamps it as done -- so the field offers the real list.
    prisma.leaveType.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return (
    <>
      <Link
        href="/payroll"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Payroll
      </Link>

      <PageHeader
        title="Payroll rules"
        description="How this organisation calculates pay. Change it here, not in code."
      />

      {errors.length > 0 ? (
        <div className="mb-4">
          <Alert tone="danger" title="The stored policy is invalid">
            Payroll is falling back to the default rules until this is fixed.
            <ul className="mt-1.5 list-inside list-disc font-mono text-xs">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </Alert>
        </div>
      ) : null}

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <div className="space-y-4">
          {/* First, and not behind the AI module. PF, ESI, professional tax and
              TDS used to be reachable only through the prompt box below, so an
              organisation without an OpenRouter key could not switch provident
              fund on at all. */}
          <Statutory canWrite={ctx.permissions.has("payroll.rules.manage")} />

          {/* Beside the drafter, not behind it. Everything else in this policy
              -- late deductions, overtime, the half-day factor, what a full
              month is, rounding, advance recovery -- could only be changed by
              asking an AI to rewrite the lot, so an organisation with no
              OpenRouter key was stuck on the shipped defaults for good. */}
          <RuleEditor initial={policy} leaveTypes={leaveTypes} />

          {ctx.modules.has("ai") ? (
            <AiRuleBuilder aiConfigured={aiConfigured} />
          ) : (
            <Alert tone="info" title="AI assistance is switched off">
              Turn on the AI module in settings to draft a whole policy from a description.
              Nothing above needs it.
            </Alert>
          )}
        </div>

        <Section title="Rules in force" description={isDefault ? "Using the shipped defaults" : "Your configured policy"}>
          <ul className="space-y-1.5 p-4 text-sm">
            {describePolicy(policy).map((line, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-muted-foreground">·</span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <p className="flex gap-1.5 border-t border-border px-4 py-3 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
            <span>
              Payroll already calculated keeps the rules it was calculated under. A new version
              applies from the date you choose onwards.
            </span>
          </p>
        </Section>
      </div>

      <div className="mt-5">
        <Section
          title="Rule simulator"
          description="Try a hypothetical employee against the rules in force before applying them to anyone."
        >
          <div className="p-4">
            <Simulator />
          </div>
        </Section>
      </div>
    </>
  );
}
