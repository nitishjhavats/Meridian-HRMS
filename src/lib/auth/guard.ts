import { prisma } from "../db/prisma";
import {
  ForbiddenError,
  FeatureDisabledError,
  NotFoundError,
  SubscriptionReadOnlyError,
  UnauthorizedError,
} from "../errors";
import type { ModuleKey } from "../features";
import { isReadOnly } from "@/domain/billing/seats";
import { liveReportingWhere } from "@/domain/reporting/window";
import type { AuthContext } from "./context";
import { type Permission, type Scope, resolveScope } from "./permissions";

/**
 * Authorisation guards.
 *
 * Every route handler calls these even when the UI has already hidden the
 * control — hiding a button is cosmetics, this is the boundary.
 */

export function requirePermission(ctx: AuthContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw new ForbiddenError("You do not have permission to do that.");
  }
}

export function requireAnyPermission(ctx: AuthContext, permissions: Permission[]): void {
  if (!permissions.some((p) => ctx.permissions.has(p))) {
    throw new ForbiddenError("You do not have permission to do that.");
  }
}

export function hasPermission(ctx: AuthContext, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

export function requireSuperadmin(ctx: AuthContext): void {
  if (!ctx.isSuperadmin) throw new ForbiddenError("This area is restricted to the platform owner.");
}

/** Narrows the context to one that definitely has a tenant. */
export function requireOrg(ctx: AuthContext): asserts ctx is AuthContext & { organizationId: string } {
  if (!ctx.organizationId) {
    throw new ForbiddenError("This action requires an organisation context.");
  }
}

export function requireModule(ctx: AuthContext, module: ModuleKey): void {
  if (!ctx.modules.has(module)) throw new FeatureDisabledError(module);
}

/**
 * Blocks writes when the subscription has lapsed or a Superadmin is in read-only
 * view. Reads still work, so an admin can always reach the payment screen.
 */
export function requireWritable(ctx: AuthContext): void {
  if (ctx.readOnlyView) {
    throw new ForbiddenError("You are viewing this organisation in read-only support mode.");
  }
  if (isReadOnly(ctx.accessState)) {
    throw new SubscriptionReadOnlyError(
      ctx.accessState === "TRIAL_EXPIRED"
        ? "Your trial has ended. Add seats to continue making changes."
        : "Your subscription has lapsed. Complete payment to continue making changes.",
    );
  }
}

/** Convenience: permission + module + writability in one call. */
export function requireWrite(ctx: AuthContext, permission: Permission, module?: ModuleKey): void {
  requirePermission(ctx, permission);
  if (module) requireModule(ctx, module);
  requireWritable(ctx);
}

// ------------------------------------------------------------------ scoping

/**
 * How much of the organisation this user may see for a permission family such as
 * `employee.read` or `attendance.read`. The client never supplies a scope.
 */
export function scopeFor(ctx: AuthContext, family: string): Scope {
  const scope = resolveScope(ctx.permissions, family);
  if (!scope) throw new ForbiddenError("You do not have permission to view that.");
  return scope;
}

/**
 * Employee ids visible under a scope — used to build a `where` clause.
 * `null` means "no restriction" (organisation-wide).
 */
export async function visibleEmployeeIds(
  ctx: AuthContext,
  family: string,
): Promise<string[] | null> {
  const scope = scopeFor(ctx, family);
  if (scope === "all") return null;
  if (scope === "self") return ctx.employeeId ? [ctx.employeeId] : [];
  return teamEmployeeIds(ctx);
}

/**
 * Everyone reporting to this user, transitively, plus the user.
 *
 * Reporting is a matrix, not a tree — someone can report to two managers — so
 * this is a breadth-first walk with a visited set and a depth cap rather than a
 * recursive descent that a cycle could hang.
 */
export async function teamEmployeeIds(ctx: AuthContext, maxDepth = 6): Promise<string[]> {
  requireOrg(ctx);
  if (!ctx.employeeId) return [];

  const seen = new Set<string>([ctx.employeeId]);
  let frontier = [ctx.employeeId];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const reports = await prisma.reportingRelationship.findMany({
      where: {
        organizationId: ctx.organizationId,
        managerId: { in: frontier },
        ...liveReportingWhere(ctx.organization?.timezone ?? "Asia/Kolkata"),
      },
      select: { employeeId: true },
    });

    frontier = [];
    for (const r of reports) {
      if (seen.has(r.employeeId)) continue;
      seen.add(r.employeeId);
      frontier.push(r.employeeId);
    }
  }

  return [...seen];
}

export async function canSeeEmployee(
  ctx: AuthContext,
  employeeId: string,
  family = "employee.read",
): Promise<boolean> {
  const allowed = await visibleEmployeeIds(ctx, family);
  return allowed === null || allowed.includes(employeeId);
}

// ------------------------------------------------------------------ tenancy

/**
 * Belt-and-braces check before touching a row that was fetched by id.
 *
 * A cross-tenant hit raises 404, not 403 — confirming that an id exists but
 * belongs to someone else is itself an information leak.
 */
export function assertSameTenant(
  ctx: AuthContext,
  row: { organizationId: string | null } | null | undefined,
  what = "That record",
): asserts row is { organizationId: string } {
  if (!row) throw new NotFoundError(what);
  if (!ctx.organizationId || row.organizationId !== ctx.organizationId) {
    throw new NotFoundError(what);
  }
}

/**
 * The tenant filter every organisation-scoped query must start from.
 * Using this rather than a hand-written `where` is what keeps isolation uniform.
 */
export function tenantWhere(ctx: AuthContext): { organizationId: string } {
  if (!ctx.organizationId) throw new UnauthorizedError("No organisation in this session.");
  return { organizationId: ctx.organizationId };
}

/** Combines the tenant filter with a scope restriction on employee id. */
export async function scopedEmployeeWhere(
  ctx: AuthContext,
  family: string,
): Promise<{ organizationId: string; employeeId?: { in: string[] } }> {
  const base = tenantWhere(ctx);
  const ids = await visibleEmployeeIds(ctx, family);
  return ids === null ? base : { ...base, employeeId: { in: ids } };
}
