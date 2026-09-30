import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission } from "@/lib/auth/guard";
import type { AuditRow } from "@/components/audit/AuditTable";

/**
 * Reading the audit log.
 *
 * The platform owner sees every tenant; anyone else sees only their own
 * organisation's rows. The filter is derived from the context, never from a
 * query parameter.
 */
export async function listAuditLog(ctx: AuthContext, take = 200): Promise<AuditRow[]> {
  requirePermission(ctx, "audit.read");

  return prisma.auditLog.findMany({
    where: ctx.isSuperadmin ? {} : { organizationId: ctx.organizationId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      createdAt: true,
      action: true,
      entityType: true,
      entityId: true,
      actorEmail: true,
      before: true,
      after: true,
      organization: { select: { name: true } },
    },
  });
}
