import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { decryptOptional, encryptField } from "@/lib/crypto/field";
import { writeAudit } from "@/lib/audit";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { DEFAULT_MODEL, complete, resolveCredentials } from "@/lib/ai/openrouter";

/**
 * An organisation's AI settings.
 *
 * The API key is the whole reason this file is careful. It is written encrypted,
 * read only inside `lib/ai/openrouter.ts`, and never leaves the server — not in
 * a response, not in an audit row, not in an error message. What the screen gets
 * instead is the last four characters and where the key came from, which is
 * enough to answer "is the right key installed?" without being enough to spend
 * anyone's money.
 */

/** Where the key that would actually be used comes from. */
export type KeySource = "ORGANISATION" | "PLATFORM" | "NONE";

export interface AiConfigView {
  enabled: boolean;
  provider: string;
  /** Blank means "use the platform default". */
  model: string;
  /** The model a request would really be sent to right now. */
  effectiveModel: string;
  platformModel: string;
  temperature: number;
  maxTokens: number;
  monthlyTokenCap: number | null;
  tokensUsedThisMonth: number;
  usageResetAt: string | null;
  key: {
    source: KeySource;
    /** Masked tail of the organisation's own key, if it has one. */
    hint: string | null;
    /** Whether the platform has a fallback key configured. */
    platformAvailable: boolean;
    /**
     * Whether this organisation may set its own key, or has to send it to
     * Broadmate Global to be entered on their behalf. Decided per organisation
     * by the Superadmin.
     */
    orgMayManage: boolean;
  };
  letterSystemPrompt: string | null;
  payrollSystemPrompt: string | null;
  updatedAt: string | null;
}

/**
 * A fixed-width hint rather than a dot per character: an OpenRouter key is ~70
 * characters, and a 70-dot mask both wraps badly and quietly advertises the
 * key's length. Four characters is enough to tell two keys apart.
 */
function keyHint(key: string): string {
  return `••••${key.slice(-4)}`;
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getAiConfig(ctx: AuthContext): Promise<AiConfigView> {
  requireOrg(ctx);
  requirePermission(ctx, "ai.config.manage");

  const [config, platform] = await Promise.all([
    prisma.aiConfig.findUnique({ where: { organizationId: ctx.organizationId } }),
    prisma.platformSetting.findUnique({ where: { id: "singleton" } }),
  ]);

  const orgKey = decryptOptional(config?.apiKeyCipher ?? null);
  const platformAvailable = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  const platformModel = platform?.defaultAiModel || DEFAULT_MODEL;

  // A counter that has not been reset since last month is showing last month's
  // spend. Report it as zero, the same way `resolveCredentials` treats it.
  const stale = !config?.usageResetAt || config.usageResetAt < monthStart();

  return {
    enabled: config?.enabled ?? true,
    provider: config?.provider ?? "openrouter",
    model: config?.model ?? "",
    effectiveModel: config?.model?.trim() || platformModel,
    platformModel,
    temperature: config ? Number(config.temperature) : 0.3,
    maxTokens: config?.maxTokens ?? 4096,
    monthlyTokenCap: config?.monthlyTokenCap ?? null,
    tokensUsedThisMonth: stale ? 0 : config.tokensUsedThisMonth,
    usageResetAt: config?.usageResetAt?.toISOString() ?? null,
    key: {
      source: orgKey ? "ORGANISATION" : platformAvailable ? "PLATFORM" : "NONE",
      hint: orgKey ? keyHint(orgKey) : null,
      platformAvailable,
      // No row yet means nobody has decided, and the default is that the
      // organisation looks after its own key.
      orgMayManage: config?.orgMayManageKey ?? true,
    },
    letterSystemPrompt: config?.letterSystemPrompt ?? null,
    payrollSystemPrompt: config?.payrollSystemPrompt ?? null,
    updatedAt: config?.updatedAt.toISOString() ?? null,
  };
}

export interface UpdateAiConfigInput {
  enabled?: boolean;
  /** Empty string means "fall back to the platform default model". */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** `null` removes the cap. */
  monthlyTokenCap?: number | null;
  /**
   * Absent leaves the stored key alone; `null` deletes it and falls back to the
   * platform key; a string replaces it.
   */
  apiKey?: string | null;
  letterSystemPrompt?: string | null;
  payrollSystemPrompt?: string | null;
}

export async function updateAiConfig(
  ctx: AuthContext,
  input: UpdateAiConfigInput,
): Promise<AiConfigView> {
  requireOrg(ctx);
  requireWrite(ctx, "ai.config.manage", "ai");

  const existing = await prisma.aiConfig.findUnique({
    where: { organizationId: ctx.organizationId },
  });

  const data: Record<string, unknown> = {};
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.model !== undefined) data.model = input.model.trim();
  if (input.temperature !== undefined) data.temperature = input.temperature;
  if (input.maxTokens !== undefined) data.maxTokens = input.maxTokens;
  if (input.monthlyTokenCap !== undefined) data.monthlyTokenCap = input.monthlyTokenCap;
  if (input.letterSystemPrompt !== undefined) {
    data.letterSystemPrompt = input.letterSystemPrompt?.trim() || null;
  }
  if (input.payrollSystemPrompt !== undefined) {
    data.payrollSystemPrompt = input.payrollSystemPrompt?.trim() || null;
  }

  // What happened to the key, for the audit row — never the key itself.
  let keyChange: "set" | "cleared" | "unchanged" = "unchanged";
  if (input.apiKey !== undefined) {
    // The Superadmin decides, per organisation, whether its own administrator
    // holds the key or sends it over. Checked here rather than only hidden in
    // the UI, because hiding a control is not the same as refusing the request.
    if (existing && !existing.orgMayManageKey) {
      throw new ForbiddenError(
        "Your API key is held by Broadmate Global for this organisation. Send it to them and they will set it for you.",
      );
    }
    const key = input.apiKey?.trim() ?? "";
    if (key === "") {
      data.apiKeyCipher = null;
      keyChange = "cleared";
    } else {
      // Not a format check on the provider's behalf — just enough to catch a
      // pasted placeholder or a truncated copy before it becomes a 401 later.
      if (key.length < 20) {
        throw new ValidationError("That does not look like an OpenRouter API key.");
      }
      if (key.includes(" ") || key.includes("\n")) {
        throw new ValidationError("The API key contains spaces. Paste it without line breaks.");
      }
      data.apiKeyCipher = encryptField(key);
      keyChange = "set";
    }
  }

  const saved = await prisma.aiConfig.upsert({
    where: { organizationId: ctx.organizationId },
    create: { organizationId: ctx.organizationId, ...data },
    update: data,
  });

  await writeAudit(ctx, {
    action: "ai.config_updated",
    entityType: "AiConfig",
    entityId: saved.id,
    before: existing
      ? {
          enabled: existing.enabled,
          model: existing.model,
          temperature: Number(existing.temperature),
          maxTokens: existing.maxTokens,
          monthlyTokenCap: existing.monthlyTokenCap,
        }
      : null,
    after: {
      enabled: saved.enabled,
      model: saved.model,
      temperature: Number(saved.temperature),
      maxTokens: saved.maxTokens,
      monthlyTokenCap: saved.monthlyTokenCap,
    },
    metadata: { apiKey: keyChange },
  });

  return getAiConfig(ctx);
}

export interface AiTestResult {
  ok: true;
  model: string;
  keySource: KeySource;
  reply: string;
  tokensUsed: number;
}

/**
 * Proves the saved settings actually work.
 *
 * A "Save" button that succeeds while the key is wrong is worse than no button:
 * the failure then surfaces halfway through drafting a payroll policy. This
 * spends a few tokens to move that discovery to the settings screen.
 */
export async function testAiConnection(ctx: AuthContext): Promise<AiTestResult> {
  requireOrg(ctx);
  requirePermission(ctx, "ai.config.manage");

  const credentials = await resolveCredentials(ctx.organizationId);
  const result = await complete(ctx.organizationId, {
    messages: [
      { role: "system", content: "You are a connection test. Answer in one word." },
      { role: "user", content: "Reply with the word: ready" },
    ],
    temperature: 0,
    // Enough headroom for a reasoning model to think before saying one word.
    maxTokens: 256,
  });

  return {
    ok: true,
    model: result.model,
    keySource: credentials.ownKey ? "ORGANISATION" : "PLATFORM",
    reply: result.content.trim().slice(0, 120),
    tokensUsed: result.promptTokens + result.completionTokens,
  };
}
