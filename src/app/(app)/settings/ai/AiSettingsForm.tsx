"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  PlugZap,
  Save,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NumberField } from "@/components/ui/number-field";
import { Field } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/states";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RequestFailed, api, mutate } from "@/lib/client/api";
import { AI_MODELS, findModel } from "@/lib/ai/models";

/**
 * AI settings.
 *
 * The key field is write-only by construction: the server never sends a key
 * back, so this form has nothing to prefill and nothing to leak. What it shows
 * instead is the masked tail and where the active key came from — enough to
 * answer "is the right key installed?" without holding the secret.
 */

export interface AiConfigView {
  enabled: boolean;
  provider: string;
  model: string;
  effectiveModel: string;
  platformModel: string;
  temperature: number;
  maxTokens: number;
  monthlyTokenCap: number | null;
  tokensUsedThisMonth: number;
  usageResetAt: string | null;
  key: {
    source: "ORGANISATION" | "PLATFORM" | "NONE";
    hint: string | null;
    platformAvailable: boolean;
    /**
     * Whether this organisation may set its own key at all.
     *
     * Off means Broadmate Global holds it: the customer sends the key over and
     * it is entered for them. Enforced in `updateAiConfig`, which throws — so
     * the field is hidden rather than shown and refused.
     */
    orgMayManage: boolean;
  };
  letterSystemPrompt: string | null;
  payrollSystemPrompt: string | null;
  updatedAt: string | null;
}

interface TestResult {
  ok: true;
  model: string;
  keySource: string;
  reply: string;
  tokensUsed: number;
}

const SOURCE_LABEL: Record<AiConfigView["key"]["source"], string> = {
  ORGANISATION: "Your own key",
  PLATFORM: "Platform key",
  NONE: "No key",
};

export function AiSettingsForm({
  initial,
  moduleLive = true,
}: {
  initial: AiConfigView;
  /**
   * Whether the AI module is on for this organisation.
   *
   * The page stays reachable with it off, so the saved key can be seen and
   * the module switched back on -- but `updateAiConfig` refuses every write
   * until then. Off locks the fields and the two buttons that would be
   * refused; the connection test has no module check and stays available.
   */
  moduleLive?: boolean;
}) {
  const router = useRouter();
  const locked = !moduleLive;
  const [config, setConfig] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  // A model we do not list is still a valid choice; remember that the field
  // should stay a text box rather than snapping back to a dropdown entry.
  const [custom, setCustom] = useState(
    () => initial.model !== "" && !findModel(initial.model),
  );

  function set<K extends keyof AiConfigView>(key: K, value: AiConfigView[K]) {
    setConfig((c) => ({ ...c, [key]: value }));
  }

  async function save(extra: Record<string, unknown> = {}) {
    setBusy(true);
    setTest(null);
    const result = await mutate(
      () =>
        api<{ config: AiConfigView }>("/api/ai/config", {
          method: "PATCH",
          body: {
            enabled: config.enabled,
            model: config.model,
            temperature: config.temperature,
            maxTokens: config.maxTokens,
            monthlyTokenCap: config.monthlyTokenCap,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            ...extra,
          },
        }),
      { success: "AI settings saved.", error: "Those settings were not saved" },
    );
    setBusy(false);
    if (result) {
      setConfig(result.config);
      setApiKey("");
      setShowKey(false);
      router.refresh();
    }
  }

  async function removeKey() {
    setBusy(true);
    const result = await mutate(
      () =>
        api<{ config: AiConfigView }>("/api/ai/config", {
          method: "PATCH",
          body: { apiKey: null },
        }),
      {
        success: config.key.platformAvailable
          ? "Key removed. The platform key will be used."
          : "Key removed. AI features are now unavailable.",
        error: "The key was not removed",
      },
    );
    setBusy(false);
    if (result) {
      setConfig(result.config);
      setTest(null);
      router.refresh();
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    setTestError(null);
    try {
      const result = await api<{ test: TestResult }>("/api/ai/config", {
        method: "POST",
        body: { action: "test" },
      });
      setTest(result.test);
    } catch (error) {
      setTestError(
        error instanceof RequestFailed ? error.error.message : "We could not reach the server.",
      );
    } finally {
      setTesting(false);
    }
  }

  const capUsed =
    config.monthlyTokenCap && config.monthlyTokenCap > 0
      ? Math.min(100, Math.round((config.tokensUsedThisMonth / config.monthlyTokenCap) * 100))
      : null;

  return (
    <div className="space-y-4">
      {/* Not while the module is off: "add a key below" beside a locked field
          would contradict the banner above that says why it is locked. */}
      {config.key.source === "NONE" && config.key.orgMayManage && !locked ? (
        <Alert tone="warning" title="AI features are not usable yet">
          Add an OpenRouter API key below. Until then, letter drafting and AI payroll setup will
          say so rather than failing halfway through.
        </Alert>
      ) : null}

      {/* Said before the feature is used, not buried in a policy.
          The product transmits to a third party here and nowhere else, and an
          administrator switching this on is entitled to know exactly what
          leaves — particularly the reassuring half, that employee names and
          salary figures do not. */}
      <Alert tone="info" title="What is sent, and where">
        <p>
          AI features send your request to <span className="font-medium">OpenRouter</span>, which
          passes it to the model you choose. Two things go: for a letter, the letter type and the
          instruction you type — the model writes a template full of placeholders, and your
          employees&rsquo; real names, salaries and dates are filled in here afterwards, so they
          never leave this server. For payroll rules, your rule configuration and your
          instruction.
        </p>
        <p className="mt-2">
          No employee personal data, no attendance record and no document is ever sent. Switch AI
          off below and nothing leaves at all.
        </p>
      </Alert>

      {!config.key.orgMayManage ? (
        <Alert tone="info" title="Broadmate Global holds your API key">
          {config.key.hint
            ? `A key is set for your organisation (${config.key.hint}) and AI features work normally.`
            : "No key is set for your organisation yet, so AI features are unavailable."}{" "}
          Send your OpenRouter key to Broadmate Global and they will enter it for you. Everything
          else on this page is still yours to change.
        </Alert>
      ) : null}

      {/* ---------- the key ---------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden />
            OpenRouter API key
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
            <Badge tone={config.key.source === "NONE" ? "danger" : "success"}>
              {SOURCE_LABEL[config.key.source]}
            </Badge>
            <span className="tabular text-sm text-muted-foreground">
              {config.key.hint ??
                (config.key.platformAvailable
                  ? "Using the platform's key"
                  : "No key is configured anywhere")}
            </span>
            {config.key.source === "ORGANISATION" && config.key.orgMayManage ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                loading={busy}
                disabled={locked}
                onClick={removeKey}
              >
                <Trash2 className="size-4" aria-hidden />
                Remove
              </Button>
            ) : null}
          </div>

          {config.key.orgMayManage ? (
            <>
            <Field
              label={config.key.source === "ORGANISATION" ? "Replace the key" : "Add a key"}
              htmlFor="apiKey"
              hint="Stored encrypted. It is never shown again, not even to you — replace it if you lose it."
            >
              <div className="flex gap-2">
                <Input
                  id="apiKey"
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-or-v1-…"
                  disabled={locked}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  disabled={locked}
                  aria-label={showKey ? "Hide the key" : "Show the key"}
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </Field>

            <p className="text-xs text-muted-foreground">
              Get one from{" "}
              <a
                href="https://openrouter.ai/keys"
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2 hover:text-foreground"
              >
                openrouter.ai/keys
              </a>
              . Usage is billed to that account, not to this platform.
            </p>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ---------- model & limits ---------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            Model and limits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">AI features enabled</p>
              <p className="text-xs text-muted-foreground">
                Off switches off drafting everywhere without deleting the key.
              </p>
            </div>
            <Switch
              checked={config.enabled}
              disabled={locked}
              onCheckedChange={(v) => set("enabled", v)}
              aria-label="AI features enabled"
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2">
            <Field
              label="Model"
              htmlFor="model"
              hint={
                custom
                  ? "Any OpenRouter model id, exactly as it appears on their site."
                  : (findModel(config.model)?.note ??
                    `Blank uses the platform default (${config.platformModel}).`)
              }
            >
              <Select
                id="model"
                value={custom ? "__custom" : config.model}
                disabled={locked}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === "__custom") {
                    setCustom(true);
                    return;
                  }
                  setCustom(false);
                  set("model", value);
                }}
              >
                <option value="">Platform default ({config.platformModel})</option>
                {AI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                    {m.free ? " — free" : ""}
                  </option>
                ))}
                <option value="__custom">Something else…</option>
              </Select>
              {custom ? (
                <Input
                  className="mt-2"
                  value={config.model}
                  spellCheck={false}
                  placeholder="provider/model-id"
                  aria-label="Custom model id"
                  disabled={locked}
                  onChange={(e) => set("model", e.target.value)}
                />
              ) : null}
            </Field>

            <Field
              label="Creativity"
              htmlFor="temperature"
              hint="Lower is more literal. Payroll rules should stay near 0."
            >
              <Select
                id="temperature"
                value={String(config.temperature)}
                disabled={locked}
                onChange={(e) => set("temperature", Number(e.target.value))}
              >
                <option value="0">0 — deterministic</option>
                <option value="0.3">0.3 — precise (recommended)</option>
                <option value="0.7">0.7 — balanced</option>
                <option value="1">1 — creative</option>
              </Select>
            </Field>

            <Field
              label="Max tokens per request"
              htmlFor="maxTokens"
              hint="A ceiling on the length of one reply."
            >
              <NumberField
                id="maxTokens"
                min={256}
                max={32000}
                className="tabular"
                disabled={locked}
                value={config.maxTokens}
                // Emptying this used to plant 2048 — a ceiling nobody typed,
                // and then saved. Blank falls to the minimum instead.
                onValueChange={(v) => set("maxTokens", v ?? 256)}
              />
            </Field>

            <Field
              label="Monthly token cap"
              htmlFor="monthlyTokenCap"
              hint="Blank means no cap. A runaway loop is the expensive failure here."
            >
              <NumberField
                id="monthlyTokenCap"
                min={1000}
                className="tabular"
                disabled={locked}
                value={config.monthlyTokenCap}
                placeholder="No cap"
                // The one box on this screen where empty is a real answer: blank
                // is "no cap", not a cap of zero.
                onValueChange={(v) => set("monthlyTokenCap", v)}
              />
            </Field>
          </div>

          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">Used this month</span>
              <span className="tabular font-medium">
                {config.tokensUsedThisMonth.toLocaleString("en-IN")}
                {config.monthlyTokenCap
                  ? ` / ${config.monthlyTokenCap.toLocaleString("en-IN")}`
                  : ""}{" "}
                tokens
              </span>
            </div>
            {capUsed !== null ? (
              <div
                className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-border"
                role="progressbar"
                aria-valuenow={capUsed}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Monthly token usage"
              >
                <div
                  className={capUsed >= 90 ? "h-full bg-danger" : "h-full bg-primary"}
                  style={{ width: `${capUsed}%` }}
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button loading={busy} disabled={locked} onClick={() => save()}>
              <Save className="size-4" aria-hidden />
              Save settings
            </Button>
            <Button
              variant="secondary"
              loading={testing}
              disabled={config.key.source === "NONE"}
              onClick={runTest}
            >
              <PlugZap className="size-4" aria-hidden />
              Test connection
            </Button>
          </div>

          {test ? (
            <Alert tone="success" title="The connection works">
              <span className="flex flex-wrap items-center gap-1.5">
                <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                <span>
                  {test.model} replied “{test.reply}” using {test.tokensUsed} tokens.
                </span>
              </span>
            </Alert>
          ) : null}
          {testError ? (
            <Alert tone="danger" title="The test failed">
              {testError}
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
