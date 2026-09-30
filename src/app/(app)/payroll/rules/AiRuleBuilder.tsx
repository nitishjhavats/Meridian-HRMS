"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Lightbulb,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequestFailed, api, mutate } from "@/lib/client/api";
import { formatMoney } from "@/lib/utils";

/**
 * AI payroll setup.
 *
 * The model proposes; a human decides. Everything between those two steps —
 * schema validation, conflict analysis, and sample payslips from the real
 * engine — exists so the human is deciding on evidence rather than on trust.
 *
 * There is no path from this screen to an activated policy that does not pass
 * through the Approve button.
 */

interface Finding {
  severity: "BLOCKER" | "WARNING" | "ASSUMPTION" | "CHANGE";
  area: string;
  message: string;
  suggestion?: string;
}

interface Sample {
  name: string;
  description: string;
  current: { netPaise: number; grossPaise: number } | null;
  proposed: { netPaise: number; grossPaise: number };
}

interface Proposal {
  policy: unknown;
  description: string[];
  findings: Finding[];
  blockers: Finding[];
  activatable: boolean;
  samples: Sample[];
  model?: string;
  tokensUsed?: number;
}

const SEVERITY: Record<
  Finding["severity"],
  { tone: "danger" | "warning" | "info" | "neutral"; icon: typeof AlertTriangle; label: string }
> = {
  BLOCKER: { tone: "danger", icon: TriangleAlert, label: "Must fix" },
  WARNING: { tone: "warning", icon: AlertTriangle, label: "Check this" },
  ASSUMPTION: { tone: "info", icon: Lightbulb, label: "Assumed" },
  CHANGE: { tone: "neutral", icon: Info, label: "Changed" },
};

const EXAMPLES = [
  "Employees work 9 hours with Sunday as the weekly off. If someone is more than 30 minutes late, deduct half a day. Sunday work should be paid at 1.5x.",
  "Split salary as 50% basic, 20% HRA, 20% special allowance and 10% other. Round net pay to the nearest rupee.",
  "Three late arrivals in a month cost half a day's pay. Working on a holiday earns a compensatory off instead of extra money.",
];

export function AiRuleBuilder({ aiConfigured }: { aiConfigured: boolean }) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState(() => {
    // Default to the first of next month: changing rules mid-period would apply
    // new thresholds to days already worked under the old ones.
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10);
  });

  async function generate() {
    setBusy(true);
    setError(null);
    setIssues([]);
    setProposal(null);

    try {
      const result = await api<{ proposal: Proposal }>("/api/payroll/rules", {
        method: "POST",
        body: { action: "generate", prompt },
      });
      setProposal(result.proposal);
    } catch (err) {
      if (err instanceof RequestFailed) {
        setError(err.error.message);
        const details = err.error.details as { issues?: { path: string; message: string }[] } | undefined;
        if (details?.issues) setIssues(details.issues);
      } else {
        setError("We could not reach the server. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!proposal) return;
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ version: number }>("/api/payroll/rules", {
          method: "POST",
          body: {
            action: "activate",
            policy: proposal.policy,
            effectiveFrom,
            note: "Generated with AI and approved",
            aiPrompt: prompt,
          },
        }),
      { success: "Payroll rules activated.", error: "Those rules could not be activated" },
    );
    setBusy(false);
    if (result) {
      setProposal(null);
      setPrompt("");
      router.refresh();
    }
  }

  const grouped = proposal
    ? (["BLOCKER", "WARNING", "ASSUMPTION", "CHANGE"] as const).map((severity) => ({
        severity,
        items: proposal.findings.filter((f) => f.severity === severity),
      }))
    : [];

  return (
    <div className="space-y-4">
      {!aiConfigured ? (
        <Alert tone="warning" title="No AI key configured">
          Add an OpenRouter key in Settings → AI, or ask the platform owner to set a default one.
          You can still edit payroll rules by hand.
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            Describe your payroll rules
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field
            label="In your own words"
            htmlFor="prompt"
            hint="The AI drafts a configuration. Nothing changes until you read it and approve."
          >
            <Textarea
              id="prompt"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={EXAMPLES[0]}
              disabled={!aiConfigured}
            />
          </Field>

          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((example, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setPrompt(example)}
                disabled={!aiConfigured}
                className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
              >
                Example {i + 1}
              </button>
            ))}
          </div>

          <Button
            loading={busy}
            disabled={!aiConfigured || prompt.trim().length < 10}
            onClick={generate}
          >
            <Sparkles className="size-4" aria-hidden />
            Draft the rules
          </Button>

          {error ? (
            <Alert tone="danger" title="Nothing was changed">
              {error}
              {issues.length > 0 ? (
                <ul className="mt-2 list-inside list-disc font-mono text-xs">
                  {issues.map((issue, i) => (
                    <li key={i}>
                      {issue.path}: {issue.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      {proposal ? (
        <>
          {/* ---------- what it understood ---------- */}
          <Card>
            <CardHeader>
              <CardTitle>What these rules say</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-sm">
                {proposal.description.map((line, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted-foreground">·</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {proposal.model ? (
                <p className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
                  Drafted by {proposal.model}
                  {proposal.tokensUsed ? ` · ${proposal.tokensUsed} tokens` : ""}. Read it before
                  approving — the AI is a drafting tool, not the authority on your payroll.
                </p>
              ) : null}
            </CardContent>
          </Card>

          {/* ---------- findings ---------- */}
          {proposal.findings.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Review</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {grouped
                  .filter((g) => g.items.length > 0)
                  .map((group) => {
                    const meta = SEVERITY[group.severity];
                    return (
                      <div key={group.severity}>
                        <p className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
                          <meta.icon className="size-4" aria-hidden />
                          {meta.label}
                          <Badge tone={meta.tone}>{group.items.length}</Badge>
                        </p>
                        <ul className="space-y-1.5">
                          {group.items.map((finding, i) => (
                            <li key={i} className="rounded-md border border-border px-2.5 py-2 text-sm">
                              <span className="text-xs text-muted-foreground">{finding.area}</span>
                              <p>{finding.message}</p>
                              {finding.suggestion ? (
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                  {finding.suggestion}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
              </CardContent>
            </Card>
          ) : null}

          {/* ---------- sample payslips ---------- */}
          <Card>
            <CardHeader>
              <CardTitle>What it would pay</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">
                The same three scenarios under the current rules and the proposed ones, computed by
                the engine that runs real payroll.
              </p>
              <ul className="space-y-2">
                {proposal.samples.map((sample) => {
                  const delta = sample.current
                    ? sample.proposed.netPaise - sample.current.netPaise
                    : 0;
                  return (
                    <li
                      key={sample.name}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{sample.name}</p>
                        <p className="text-xs text-muted-foreground">{sample.description}</p>
                      </div>
                      <div className="text-right text-sm">
                        {sample.current ? (
                          <span className="text-muted-foreground">
                            {formatMoney(sample.current.netPaise)} →{" "}
                          </span>
                        ) : null}
                        <span className="tabular font-semibold">
                          {formatMoney(sample.proposed.netPaise)}
                        </span>
                        {delta !== 0 ? (
                          <span
                            className={`ml-1.5 text-xs ${delta > 0 ? "text-success-text" : "text-danger-text"}`}
                          >
                            {delta > 0 ? "+" : "−"}
                            {formatMoney(Math.abs(delta))}
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          {/* ---------- approve ---------- */}
          <Card>
            <CardHeader>
              <CardTitle>Activate</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!proposal.activatable ? (
                <Alert tone="danger" title="Not ready to activate">
                  Fix the blocking problems above first. Rephrase your description and draft again.
                </Alert>
              ) : (
                <Alert tone="info" title="This does not change past payroll">
                  A new policy version is created from the date you choose. Any month already
                  calculated keeps the rules it was calculated under.
                </Alert>
              )}

              <Field
                label="Effective from"
                htmlFor="effectiveFrom"
                required
                hint="The first of next month is usually right — mid-period changes apply new thresholds to days already worked."
              >
                <Input
                  id="effectiveFrom"
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              </Field>

              <div className="flex gap-2">
                <Button
                  variant="success"
                  loading={busy}
                  disabled={!proposal.activatable}
                  onClick={activate}
                >
                  <CheckCircle2 className="size-4" aria-hidden />
                  Approve &amp; activate
                </Button>
                <Button variant="ghost" onClick={() => setProposal(null)}>
                  Discard
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
