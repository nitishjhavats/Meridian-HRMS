import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { decryptOptional, encryptField } from "@/lib/crypto/field";
import { writeAudit } from "@/lib/audit";

/**
 * The Superadmin's side of an organisation's AI credentials.
 *
 * Two things live here, and they are separate on purpose.
 *
 * The **key** can be set on an organisation's behalf. Some customers will not
 * put an OpenRouter key into a screen themselves — they will send it over and
 * expect Broadmate to enter it. That is a legitimate way to work, and the
 * alternative is somebody pasting it into a chat and it living there.
 *
 * The **policy** decides whether that organisation's own administrator may set
 * or clear the key at all. Off means Broadmate holds it. It is enforced in the
 * organisation-side service, not merely hidden in its UI.
 *
 * The key is encrypted at rest with `PLATFORM_ENCRYPTION_KEY` either way. Which
 * of the two people typed it changes nothing about how it is stored.
 */

export interface OrgAiView {
  organizationId: string;
  enabled: boolean;
  model: string;
  keyHint: string | null;
  orgMayManageKey: boolean;
  monthlyTokenCap: number | null;
  tokensUsedThisMonth: number;
}

function hint(key: string): string {
  return `••••${key.slice(-4)}`;
}

export async function getOrgAi(ctx: AuthContext, organizationId: string): Promise<OrgAiView> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.read");

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });
  if (!organization) throw new NotFoundError("That organisation");

  const config = await prisma.aiConfig.findUnique({ where: { organizationId } });
  const key = config?.apiKeyCipher ? decryptOptional(config.apiKeyCipher) : null;

  return {
    organizationId,
    enabled: config?.enabled ?? true,
    model: config?.model ?? "",
    keyHint: key ? hint(key) : null,
    orgMayManageKey: config?.orgMayManageKey ?? true,
    monthlyTokenCap: config?.monthlyTokenCap ?? null,
    tokensUsedThisMonth: config?.tokensUsedThisMonth ?? 0,
  };
}

export interface SetOrgAiInput {
  /** Undefined leaves it alone; an empty string clears it. */
  apiKey?: string;
  orgMayManageKey?: boolean;
  model?: string;
  monthlyTokenCap?: number | null;
}

export async function setOrgAi(
  ctx: AuthContext,
  organizationId: string,
  input: SetOrgAiInput,
): Promise<OrgAiView> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.update");

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true },
  });
  if (!organization) throw new NotFoundError("That organisation");

  const existing = await prisma.aiConfig.findUnique({ where: { organizationId } });

  const data: Record<string, unknown> = {};
  if (input.orgMayManageKey !== undefined) data.orgMayManageKey = input.orgMayManageKey;
  if (input.model !== undefined) data.model = input.model.trim();
  if (input.monthlyTokenCap !== undefined) data.monthlyTokenCap = input.monthlyTokenCap;

  let keyChange: "set" | "cleared" | "unchanged" = "unchanged";
  if (input.apiKey !== undefined) {
    const key = input.apiKey.trim();
    if (key === "") {
      data.apiKeyCipher = null;
      keyChange = "cleared";
    } else {
      // Enough to catch a truncated paste or a placeholder before it becomes a
      // 401 somebody has to debug a week later.
      if (key.length < 20) throw new ValidationError("That does not look like an OpenRouter API key.");
      if (/\s/.test(key)) throw new ValidationError("The key contains whitespace. Paste it on one line.");
      data.apiKeyCipher = encryptField(key);
      keyChange = "set";
    }
  }

  await prisma.aiConfig.upsert({
    where: { organizationId },
    create: { organizationId, ...data },
    update: data,
  });

  // The key itself is never in the audit row, on either side of the change.
  await writeAudit(ctx, {
    action: "ai.config_updated",
    entityType: "AiConfig",
    entityId: organizationId,
    organizationId,
    before: {
      hadKey: Boolean(existing?.apiKeyCipher),
      orgMayManageKey: existing?.orgMayManageKey ?? true,
      model: existing?.model ?? null,
    },
    after: {
      keyChange,
      orgMayManageKey: input.orgMayManageKey ?? existing?.orgMayManageKey ?? true,
      model: input.model ?? existing?.model ?? null,
      setByPlatform: keyChange === "set",
    },
  });

  return getOrgAi(ctx, organizationId);
}
