import { prisma } from "../db/prisma";
import { decryptOptional } from "../crypto/field";
import { ExternalServiceError, ValidationError } from "../errors";

/**
 * OpenRouter client.
 *
 * Everything here runs server-side. An organisation's API key is stored
 * encrypted, decrypted only inside this module, and never returned by any route
 * — a key that reaches a browser is a key that will end up in somebody's
 * DevTools and then on somebody's bill.
 *
 * Each organisation may bring its own key; otherwise the platform's key is used.
 * The model is configurable because model ids come and go: if the provider
 * rejects the configured one, the error is surfaced verbatim rather than
 * silently swapped, so an admin can see what actually happened.
 */

export { DEFAULT_MODEL } from "./models";
import { DEFAULT_MODEL } from "./models";

export interface AiCredentials {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** True when the organisation supplied its own key. */
  ownKey: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Resolves which key and model to use.
 *
 * Throws a plain validation error rather than a 500 when nothing is configured —
 * "no AI key" is a setup problem the admin can fix, not a server fault.
 */
export async function resolveCredentials(organizationId: string): Promise<AiCredentials> {
  const [config, platform] = await Promise.all([
    prisma.aiConfig.findUnique({ where: { organizationId } }),
    prisma.platformSetting.findUnique({ where: { id: "singleton" } }),
  ]);

  if (config && !config.enabled) {
    throw new ValidationError("AI features are switched off for this organisation.");
  }

  const orgKey = decryptOptional(config?.apiKeyCipher ?? null);
  const platformKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const apiKey = orgKey ?? platformKey;

  if (!apiKey) {
    throw new ValidationError(
      "No OpenRouter API key is configured. Add one in Settings → AI, or ask the platform owner to set a default.",
    );
  }

  // A monthly cap stops a runaway loop turning into a bill.
  if (config?.monthlyTokenCap && config.tokensUsedThisMonth >= config.monthlyTokenCap) {
    throw new ValidationError(
      "This organisation has reached its monthly AI usage limit. It resets at the start of next month.",
    );
  }

  return {
    apiKey,
    model: config?.model?.trim() || platform?.defaultAiModel || DEFAULT_MODEL,
    temperature: config ? Number(config.temperature) : 0.3,
    maxTokens: config?.maxTokens ?? 4096,
    ownKey: orgKey != null,
  };
}

/** Records what a call cost, so the cap above means something. */
async function recordUsage(organizationId: string, tokens: number): Promise<void> {
  const config = await prisma.aiConfig.findUnique({
    where: { organizationId },
    select: { usageResetAt: true },
  });
  if (!config) return;

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const stale = !config.usageResetAt || config.usageResetAt < monthStart;

  await prisma.aiConfig.update({
    where: { organizationId },
    data: stale
      ? { tokensUsedThisMonth: tokens, usageResetAt: now }
      : { tokensUsedThisMonth: { increment: tokens } },
  });
}

export interface CompletionOptions {
  messages: ChatMessage[];
  /** Ask the model for strict JSON. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export async function complete(
  organizationId: string,
  options: CompletionOptions,
): Promise<CompletionResult> {
  const credentials = await resolveCredentials(organizationId);
  const baseUrl = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1";

  // Sixty seconds is generous for a completion and short enough that a hung
  // provider does not hold a request handler open.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  options.signal?.addEventListener("abort", () => controller.abort());

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter uses these for attribution on its dashboard.
        "HTTP-Referer": process.env.APP_URL ?? "http://localhost:3000",
        "X-Title": process.env.AI_APP_TITLE ?? "HRMS",
      },
      body: JSON.stringify({
        model: credentials.model,
        messages: options.messages,
        temperature: options.temperature ?? credentials.temperature,
        max_tokens: options.maxTokens ?? credentials.maxTokens,
        ...(options.json ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === "AbortError") {
      throw new ExternalServiceError("OpenRouter", "The AI request timed out. Please try again.");
    }
    throw new ExternalServiceError("OpenRouter", "Could not reach OpenRouter.", error);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      // Not JSON; the truncated body is the best detail available.
    }

    // The provider's own words. A configured model that no longer exists should
    // say so plainly rather than being quietly replaced with a different one.
    if (response.status === 400 || response.status === 404) {
      throw new ValidationError(
        `OpenRouter rejected the request for model "${credentials.model}": ${detail}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new ValidationError(
        credentials.ownKey
          ? "Your OpenRouter API key was rejected. Check it in Settings → AI."
          : "The platform's OpenRouter key was rejected. Contact the platform owner.",
      );
    }
    if (response.status === 429) {
      throw new ExternalServiceError("OpenRouter", "OpenRouter is rate-limiting requests. Try again shortly.");
    }
    throw new ExternalServiceError("OpenRouter", `OpenRouter returned ${response.status}: ${detail}`);
  }

  const payload = (await response.json()) as {
    model?: string;
    choices?: {
      finish_reason?: string;
      message?: { content?: string; reasoning?: string };
    }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  const reasoningTokens = payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const budget = options.maxTokens ?? credentials.maxTokens;

  // Reasoning models spend part of the budget thinking before they write
  // anything. Hitting the ceiling mid-thought yields a null content with
  // `finish_reason: "length"` — which is a budget problem with an obvious fix,
  // not the mystery that "empty response" would suggest.
  if (choice?.finish_reason === "length") {
    throw new ValidationError(
      reasoningTokens > 0
        ? `${credentials.model} ran out of room: it spent ${reasoningTokens} of its ${budget} tokens reasoning before answering. Raise "Max tokens per request" in Settings → AI.`
        : `The reply was cut off at ${budget} tokens. Raise "Max tokens per request" in Settings → AI.`,
    );
  }

  if (!content) {
    throw new ExternalServiceError("OpenRouter", "The AI returned an empty response.");
  }

  const promptTokens = payload.usage?.prompt_tokens ?? 0;
  const completionTokens = payload.usage?.completion_tokens ?? 0;
  await recordUsage(organizationId, promptTokens + completionTokens).catch(() => undefined);

  return {
    content,
    model: payload.model ?? credentials.model,
    promptTokens,
    completionTokens,
  };
}

/**
 * Extracts a JSON object from a completion.
 *
 * Models wrap JSON in prose or fences even when told not to, so this is
 * deliberately forgiving about the packaging while staying strict about the
 * content — the zod schema downstream is what actually decides.
 */
export function extractJson(content: string): unknown {
  const trimmed = content.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost braces.
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new ValidationError("The AI did not return valid JSON. Try rephrasing your request.");
    }
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new ValidationError("The AI returned malformed JSON. Try rephrasing your request.");
    }
  }
}

/** Whether AI is usable at all, for hiding the entry points rather than failing at them. */
export async function isAiConfigured(organizationId: string): Promise<boolean> {
  try {
    await resolveCredentials(organizationId);
    return true;
  } catch {
    return false;
  }
}
