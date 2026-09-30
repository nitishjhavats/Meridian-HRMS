import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requirePermission, requireWrite } from "@/lib/auth/guard";
import { writeAudit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  MODULES,
  type ModuleKey,
  type ModuleState,
  getModule,
  isModuleKey,
  resolveModules,
} from "@/lib/features";

/**
 * Level 2 of the feature system: what this organisation actually switches on.
 *
 * The Superadmin decides what an organisation *may* use; this decides what it
 * *does* use. Nothing here can widen a grant — a revoked module stays off no
 * matter what is posted, which is why the write path re-reads the grants rather
 * than trusting the shape of the request.
 */

export interface ModuleRow extends ModuleState {
  name: string;
  description: string;
  core: boolean;
  requires: ModuleKey[];
  /** Modules that would go dark if this one were switched off. */
  requiredBy: ModuleKey[];
  /** False for core modules and for anything the platform has not granted. */
  toggleable: boolean;
}

async function readInputs(organizationId: string) {
  const [grants, settings] = await Promise.all([
    prisma.featureGrant.findMany({
      where: { organizationId },
      select: { featureKey: true, granted: true },
    }),
    prisma.orgModuleSetting.findMany({
      where: { organizationId },
      select: { moduleKey: true, enabled: true },
    }),
  ]);

  return {
    grants: Object.fromEntries(grants.map((g) => [g.featureKey, g.granted])),
    settings: Object.fromEntries(settings.map((s) => [s.moduleKey, s.enabled])),
  };
}

export async function listModules(ctx: AuthContext): Promise<ModuleRow[]> {
  requireOrg(ctx);
  requirePermission(ctx, "org.settings.read");

  const resolved = resolveModules(await readInputs(ctx.organizationId));

  return MODULES.map((def) => {
    const state = resolved[def.key];
    return {
      ...state,
      name: def.name,
      description: def.description,
      core: def.core,
      requires: def.requires ?? [],
      requiredBy: MODULES.filter((m) => m.requires?.includes(def.key)).map((m) => m.key),
      toggleable: !def.core && state.granted,
    };
  });
}

/**
 * Switches modules on or off.
 *
 * Takes a partial map so the screen can send one toggle rather than the whole
 * board — a full replace would let a stale tab undo somebody else's change.
 */
export async function setModules(
  ctx: AuthContext,
  changes: Record<string, boolean>,
): Promise<ModuleRow[]> {
  requireOrg(ctx);
  requireWrite(ctx, "org.modules.manage");

  const entries = Object.entries(changes).filter(([key]) => isModuleKey(key));
  if (entries.length === 0) throw new ValidationError("No recognised modules were supplied.");

  const inputs = await readInputs(ctx.organizationId);

  for (const [key, enabled] of entries) {
    const def = getModule(key as ModuleKey);
    if (!def) continue;
    if (def.core) {
      throw new ValidationError(`${def.name} is part of the core product and cannot be switched off.`);
    }
    // The grant is the ceiling. Asking for a module the platform has not granted
    // is refused rather than silently ignored, so the screen can say why.
    const granted = inputs.grants[key] ?? def.defaultGranted;
    if (!granted && enabled) {
      throw new ValidationError(
        `${def.name} has not been made available to your organisation. Contact the platform owner.`,
      );
    }
  }

  await prisma.$transaction(
    entries.map(([moduleKey, enabled]) =>
      prisma.orgModuleSetting.upsert({
        where: { organizationId_moduleKey: { organizationId: ctx.organizationId!, moduleKey } },
        create: {
          organizationId: ctx.organizationId!,
          moduleKey,
          enabled,
          updatedById: ctx.userId,
        },
        update: { enabled, updatedById: ctx.userId },
      }),
    ),
  );

  await writeAudit(ctx, {
    action: "org.module_toggled",
    entityType: "OrgModuleSetting",
    before: Object.fromEntries(entries.map(([key]) => [key, inputs.settings[key] ?? null])),
    after: Object.fromEntries(entries),
  });

  return listModules(ctx);
}


/* -------------------------------------------------------------------------- */
/*  Narrowing a module for a designation, or for one person                    */
/* -------------------------------------------------------------------------- */

/**
 * The two layers below the organisation.
 *
 * The organisation's answer is a ceiling: neither of these can switch on a
 * module the platform has not granted or the company has switched off. They
 * exist to take one away -- "nobody on the shop floor needs the reimbursements
 * screen", and then "except Rahul, who does".
 *
 * A row means somebody decided. Its absence means "follow the layer above",
 * which is why removing an override is a delete rather than a third value.
 */

export interface ScopedModuleRow {
  moduleKey: ModuleKey;
  name: string;
  enabled: boolean;
}

export interface ScopedModuleView {
  /** Modules the organisation actually has, which is all these can narrow. */
  available: { key: ModuleKey; name: string; core: boolean }[];
  designations: { id: string; title: string; overrides: ScopedModuleRow[] }[];
  people: { id: string; name: string; email: string; overrides: ScopedModuleRow[] }[];
}

export async function getScopedModules(ctx: AuthContext): Promise<ScopedModuleView> {
  requireOrg(ctx);
  requirePermission(ctx, "org.settings.read");

  const resolved = resolveModules(await readInputs(ctx.organizationId));
  const available = MODULES.filter((m) => resolved[m.key]?.live).map((m) => ({
    key: m.key,
    name: m.name,
    core: m.core,
  }));
  const name = (key: string) => getModule(key as ModuleKey)?.name ?? key;

  const [designations, users] = await Promise.all([
    prisma.designation.findMany({
      where: { organizationId: ctx.organizationId!, active: true },
      select: {
        id: true,
        title: true,
        moduleSettings: { select: { moduleKey: true, enabled: true } },
      },
      orderBy: { level: "asc" },
    }),
    prisma.user.findMany({
      where: { organizationId: ctx.organizationId!, role: { not: "KIOSK" } },
      select: {
        id: true,
        name: true,
        email: true,
        moduleSettings: { select: { moduleKey: true, enabled: true } },
      },
      orderBy: { name: "asc" },
    }),
  ]);

  const shape = (rows: { moduleKey: string; enabled: boolean }[]): ScopedModuleRow[] =>
    rows
      .filter((r) => available.some((a) => a.key === r.moduleKey))
      .map((r) => ({ moduleKey: r.moduleKey as ModuleKey, name: name(r.moduleKey), enabled: r.enabled }));

  return {
    available,
    designations: designations.map((d) => ({
      id: d.id,
      title: d.title,
      overrides: shape(d.moduleSettings),
    })),
    people: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      overrides: shape(u.moduleSettings),
    })),
  };
}

export async function setScopedModule(
  ctx: AuthContext,
  input: {
    scope: "designation" | "user";
    targetId: string;
    moduleKey: string;
    /** `null` removes the override and follows the layer above again. */
    enabled: boolean | null;
  },
): Promise<ScopedModuleView> {
  requireOrg(ctx);
  requireWrite(ctx, "org.modules.manage");

  const def = getModule(input.moduleKey as ModuleKey);
  if (!def) throw new ValidationError("That is not a module.");
  if (def.core) {
    throw new ValidationError(`${def.name} is part of the core product and cannot be switched off.`);
  }

  // Tenant-checked before anything is written: an id from another organisation
  // must never become a row in this one.
  if (input.scope === "designation") {
    const found = await prisma.designation.findFirst({
      where: { id: input.targetId, organizationId: ctx.organizationId! },
      select: { id: true },
    });
    if (!found) throw new NotFoundError("That designation");
  } else {
    const found = await prisma.user.findFirst({
      where: { id: input.targetId, organizationId: ctx.organizationId! },
      select: { id: true },
    });
    if (!found) throw new NotFoundError("That person");
  }

  if (input.enabled === null) {
    if (input.scope === "designation") {
      await prisma.designationModuleSetting.deleteMany({
        where: { designationId: input.targetId, moduleKey: input.moduleKey },
      });
    } else {
      await prisma.userModuleSetting.deleteMany({
        where: { userId: input.targetId, moduleKey: input.moduleKey },
      });
    }
  } else if (input.scope === "designation") {
    await prisma.designationModuleSetting.upsert({
      where: {
        designationId_moduleKey: { designationId: input.targetId, moduleKey: input.moduleKey },
      },
      create: {
        organizationId: ctx.organizationId!,
        designationId: input.targetId,
        moduleKey: input.moduleKey,
        enabled: input.enabled,
        updatedById: ctx.userId,
      },
      update: { enabled: input.enabled, updatedById: ctx.userId },
    });
  } else {
    await prisma.userModuleSetting.upsert({
      where: { userId_moduleKey: { userId: input.targetId, moduleKey: input.moduleKey } },
      create: {
        organizationId: ctx.organizationId!,
        userId: input.targetId,
        moduleKey: input.moduleKey,
        enabled: input.enabled,
        updatedById: ctx.userId,
      },
      update: { enabled: input.enabled, updatedById: ctx.userId },
    });
  }

  await writeAudit(ctx, {
    action: "org.module_toggled",
    entityType: input.scope === "designation" ? "Designation" : "User",
    entityId: input.targetId,
    after: { moduleKey: input.moduleKey, enabled: input.enabled },
  });

  return getScopedModules(ctx);
}
