import { prisma } from "./db/prisma";
import type { AuthContext } from "./auth/context";

/**
 * Audit logging.
 *
 * Every consequential action writes one row: who, what, before, after, when, and
 * where from. Audit writes never block or fail the operation they describe — a
 * logging outage must not stop payroll — so failures are swallowed and reported
 * to the server console.
 */

export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.password_changed"
  | "auth.password_reset_requested"
  | "auth.password_reset_released"
  | "auth.password_reset_rejected"
  | "auth.password_reset_consumed"
  | "auth.session_revoked"
  | "platform.impersonation_started"
  | "platform.impersonation_ended"
  | "auth.totp_enabled"
  | "auth.totp_disabled"
  | "user.created"
  | "user.updated"
  | "user.role_changed"
  /** One permission given to, or taken from, one person on top of their role. */
  | "user.permission_changed"
  | "user.suspended"
  | "org.created"
  | "org.updated"
  | "org.suspended"
  | "org.activated"
  | "org.readonly_viewed"
  | "org.feature_granted"
  | "org.module_toggled"
  | "employee.created"
  | "employee.imported"
  | "department.created"
  | "department.updated"
  | "designation.created"
  | "designation.reordered"
  | "designation.reporting_changed"
  | "designation.updated"
  | "worklocation.created"
  | "worklocation.updated"
  | "worklocation.assigned"
  | "shift.created"
  | "shift.updated"
  | "weeklyoff.created"
  | "weeklyoff.updated"
  | "holiday.created"
  | "holiday.updated"
  | "holiday.deleted"
  | "reporting.changed"
  | "employee.updated"
  | "employee.state_changed"
  | "employee.renumbered"
  | "employee.salary_changed"
  | "attendance.marked"
  | "attendance.overridden"
  | "attendance.regularised"
  | "attendance.settings.updated"
  | "attendance.kiosk.marked"
  | "attendance.kiosk.pin_issued"
  | "attendance.kiosk.created"
  | "attendance.kiosk.updated"
  | "attendance.kiosk.password_regenerated"
  | "attendance.kiosk.revoked"
  | "attendance.day_closed"
  | "attendance.pin_authority.granted"
  | "attendance.pin_authority.revoked"
  | "leave.requested"
  | "leave.balance_adjusted"
  | "leave.carry_forward_run"
  | "leave.carry_forward_undone"
  | "leave.carry_forward_redone"
  | "leave.type.updated"
  | "leave.approved"
  | "leave.rejected"
  | "payroll.run_created"
  | "payroll.calculated"
  | "payroll.approved"
  | "payroll.locked"
  | "payroll.unlocked"
  | "payroll.adjusted"
  | "payroll.disbursed"
  | "payroll.statutory_updated"
  | "chat.conversation_exported"
  | "salary.component_created"
  | "salary.component_updated"
  | "advance.created"
  | "advance.recovered"
  | "advance.cancelled"
  | "advance.written_off"
  | "document.uploaded"
  | "document.verified"
  | "document.deletion_requested"
  | "document.deletion_approved"
  | "document.deleted"
  | "letter.generated"
  | "letter.template_updated"
  | "letter.template_restored"
  | "letter.issued"
  | "letter.revoked"
  | "payment.order_created"
  | "payment.submitted"
  | "payment.code_issued"
  | "payment.advance_code_issued"
  | "payment.advance_code_revealed"
  | "payment.advance_code_revoked"
  | "payment.approved"
  | "payment.rejected"
  | "payment.info_requested"
  | "coupon.created"
  | "coupon.updated"
  | "coupon.redeemed"
  | "settings.updated"
  | "ai.config_updated"
  | "ai.rules_generated"
  | "ai.rules_activated"
  | "export.requested"
  // Its own action, separate from the request that produced it: "somebody
  // took an export" and "somebody took a file holding every bank account in
  // the organisation" are different events, and the second is the one an
  // audit log is read for.
  | "export.identifiers.included"
  | "export.downloaded"
  | "exit.initiated"
  | "exit.settled"
  | "reimbursement.discarded"
  | "reimbursement.submitted"
  | "reimbursement.approved"
  | "reimbursement.rejected"
  | "reimbursement.paid"
  | "onboarding.assigned"
  | "onboarding.completed"
  | "asset.issued"
  | "asset.returned"
  | "asset.updated"
  | "recognition.parameters_updated"
  | "recognition.parameter_deleted"
  | "recognition.values_entered"
  | "recognition.published"
  | "ai.recognition_suggested"
  | "performance.cycle_opened"
  | "performance.review_submitted"
  | "performance.review_completed"
  | "goal.updated"
  /** One goal set for several people at once. The count is in `after`. */
  | "goal.assigned";

export interface AuditInput {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  /** Overrides the context's organisation, for platform-level events. */
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** Fields never written to an audit row, even if they appear in a before/after. */
const REDACTED_KEYS = new Set([
  "password",
  "passwordHash",
  "otpHash",
  "otpCipher",
  "tokenHash",
  "apiKeyCipher",
  "totpSecretCipher",
  "issuedCodeHash",
  "issuedCodeCipher",
  "codeHash",
  "codeCipher",
  "panCipher",
  "aadhaarCipher",
  "bankAccountCipher",
  "bankIfscCipher",
  "passwordCipher",
]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value ?? null;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

/**
 * Metadata, plus the platform owner when one is acting as somebody.
 *
 * While the superadmin is impersonating, `ctx` *is* the target — that is the
 * point, so that permissions and scopes behave exactly as they do for them. It
 * also means `actorId` and `actorEmail` name the customer's own account. Without
 * this, their audit log would claim their administrator did something Broadmate
 * did, which is the one thing act-as must never be allowed to produce.
 */
function auditMetadata(ctx: AuthContext | null, input: AuditInput): object | undefined {
  const merged = ctx?.impersonating
    ? {
        ...(input.metadata ?? {}),
        impersonatedBy: ctx.impersonating.byEmail,
        impersonationReason: ctx.impersonating.reason,
      }
    : input.metadata;
  return merged ? (redact(merged) as object) : undefined;
}

export async function writeAudit(ctx: AuthContext | null, input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId:
          input.organizationId !== undefined ? input.organizationId : (ctx?.organizationId ?? null),
        actorId: ctx?.userId ?? null,
        actorEmail: ctx?.email ?? null,
        actorRole: ctx?.role ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        before: input.before === undefined ? undefined : (redact(input.before) as object),
        after: input.after === undefined ? undefined : (redact(input.after) as object),
        metadata: auditMetadata(ctx, input),
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    console.error("[audit] failed to write audit row", { action: input.action, error });
  }
}

/**
 * Audit entry for an anonymous or pre-authentication event — a failed login, for
 * instance, where there is no context yet.
 */
export async function writeAnonymousAudit(input: AuditInput & { actorEmail?: string }): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId ?? null,
        actorEmail: input.actorEmail ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        metadata: input.metadata ? (redact(input.metadata) as object) : undefined,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    console.error("[audit] failed to write anonymous audit row", { action: input.action, error });
  }
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Shallow diff for "what changed" in the audit viewer. Only fields present in
 * `after` are compared, so a partial update does not read as deleting everything.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): FieldChange[] {
  if (!after) return [];
  const changes: FieldChange[] = [];

  for (const [field, next] of Object.entries(after)) {
    if (REDACTED_KEYS.has(field)) continue;
    const previous = before?.[field];
    const same =
      previous instanceof Date && next instanceof Date
        ? previous.getTime() === next.getTime()
        : JSON.stringify(previous ?? null) === JSON.stringify(next ?? null);
    if (!same) changes.push({ field, before: previous ?? null, after: next });
  }
  return changes;
}

/**
 * Actions the generic rule below renders badly.
 *
 * It takes the middle segment of `noun.verb`, which is right for almost
 * everything and wrong for a three-part action: "export.identifiers.included"
 * would read "Identifiers dataexportjob". That is the one line in this log
 * somebody is most likely to be looking for.
 */
const SENTENCES: Partial<Record<AuditAction, string>> = {
  "export.identifiers.included": "Exported readable bank and statutory identifiers",
  "attendance.day_closed": "Closed the day: absences recorded, open check-ins settled",
};

/** Human sentence for the audit feed. */
export function describeAudit(action: AuditAction, entityType: string): string {
  const written = SENTENCES[action];
  if (written) return written;
  const verb = action.split(".")[1]?.replaceAll("_", " ") ?? action;
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${entityType.toLowerCase()}`;
}
