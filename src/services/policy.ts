import type { PolicyKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { ForbiddenError } from "@/lib/errors";
import type { AuthContext } from "@/lib/auth/context";
import { requireOrg, requireWrite } from "@/lib/auth/guard";
import { type DateOnly, todayInZone } from "@/domain/date";
import {
  DEFAULT_ATTENDANCE_POLICY,
  safeParseAttendancePolicy,
  type AttendancePolicy,
} from "@/domain/attendance/policy";
import {
  DEFAULT_FACE_MATCH_POLICY,
  LEGACY_FACE_MATCH_POLICY,
  safeParseFaceMatchPolicy,
  type FaceMatchPolicy,
} from "@/domain/attendance/faceMatch";
import {
  DEFAULT_PAYROLL_POLICY,
  safeParsePayrollPolicy,
} from "@/domain/payroll/policy";
import {
  DEFAULT_FNF_POLICY,
  type FnfPolicy,
  safeParseFnfPolicy,
} from "@/domain/payroll/fnf";
import type { PayrollPolicy } from "@/domain/payroll/types";
import type { Permission } from "@/lib/auth/permissions";

/**
 * Resolving an organisation's rules for a given date.
 *
 * Policies are versioned with an `effectiveFrom`, so payroll for March uses the
 * rules that were in force in March even if they were rewritten in April. Every
 * caller must say *when* it is asking about; there is deliberately no "current
 * policy" shortcut that would quietly use today's rules on last quarter's data.
 */

export interface AttendanceRules extends AttendancePolicy {
  faceMatch: FaceMatchPolicy;
}

export const DEFAULT_ATTENDANCE_RULES: AttendanceRules = {
  ...DEFAULT_ATTENDANCE_POLICY,
  faceMatch: DEFAULT_FACE_MATCH_POLICY,
};

/**
 * The version in force on a date: the latest `effectiveFrom` at or before it,
 * and the highest version number among those published for the same day.
 *
 * Deliberately **not** filtered on `active`. `savePolicyVersion` retires every
 * earlier version when it publishes, so `active` marks the current head and
 * nothing else -- and with the filter here, any date before the head's
 * `effectiveFrom` matched no row at all and fell through to the shipped
 * defaults. Measured after one settings save on the live instance: payroll
 * for the previous month was calculated with the default shift and the
 * default missing-checkout rule rather than the organisation's, and the
 * nightly close judged an older date by rules that were never in force on
 * it. History is what the version rows are for; the ordering picks the right
 * one without the flag.
 */
async function loadPolicy(
  organizationId: string,
  kind: PolicyKind,
  on: DateOnly,
): Promise<unknown | null> {
  const version = await prisma.orgPolicyVersion.findFirst({
    where: {
      organizationId,
      kind,
      effectiveFrom: { lte: new Date(`${on}T00:00:00.000Z`) },
    },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
    select: { payload: true },
  });
  return version?.payload ?? null;
}

/**
 * Attendance rules for a date.
 *
 * Falls back to the shipped defaults rather than throwing — an organisation that
 * has never opened the settings screen still needs attendance to work.
 */
export async function getAttendanceRules(
  ctx: AuthContext,
  on?: DateOnly,
): Promise<AttendanceRules> {
  requireOrg(ctx);
  const date = on ?? todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  return getAttendanceRulesForOrganization(ctx.organizationId, date);
}

/**
 * The same rules, for a caller that is not a person.
 *
 * The nightly close of attendance days runs for every organisation with no
 * context to guard on; it still needs the rules that were in force on the
 * date it is closing, so this is the loader with the guard lifted out. The
 * guarded entry above is what every request-path caller uses.
 */
export async function getAttendanceRulesForOrganization(
  organizationId: string,
  date: DateOnly,
): Promise<AttendanceRules> {
  const payload = await loadPolicy(organizationId, "ATTENDANCE", date);

  if (!payload || typeof payload !== "object") return DEFAULT_ATTENDANCE_RULES;

  const stored = payload as Partial<AttendanceRules>;
  const merged = {
    ...DEFAULT_ATTENDANCE_POLICY,
    ...stored,
    shift: { ...DEFAULT_ATTENDANCE_POLICY.shift, ...stored.shift },
    overtime: { ...DEFAULT_ATTENDANCE_POLICY.overtime, ...stored.overtime },
    checkInWindow: {
      ...DEFAULT_ATTENDANCE_POLICY.checkInWindow,
      ...stored.checkInWindow,
    },
    marking: { ...DEFAULT_ATTENDANCE_POLICY.marking, ...stored.marking },
    // Off for every organisation that has never said otherwise: a stored
    // policy from before the switch existed has no `gpsAccuracy` key at all.
    gpsAccuracy: { ...DEFAULT_ATTENDANCE_POLICY.gpsAccuracy, ...stored.gpsAccuracy },
    /**
     * Face matching merges over a base, and **which base depends on whether
     * this organisation has ever had one**.
     *
     * A stored policy with no `faceMatch` key predates the block entirely --
     * which is every policy written by provisioning, because
     * `DEFAULT_ATTENDANCE_POLICY` does not carry it. Merging the strict shipped
     * default over those would have made face matching REQUIRED, and refused
     * everybody who has not enrolled, on the deploy that shipped it. So they
     * get the old behaviour until somebody chooses otherwise, and only a policy
     * that already says something about faces is merged over the new default.
     */
    faceMatch: stored.faceMatch
      ? { ...DEFAULT_FACE_MATCH_POLICY, ...stored.faceMatch }
      : LEGACY_FACE_MATCH_POLICY,
  };

  /**
   * Validate the face block instead of re-attaching whatever was stored.
   *
   * This used to end `faceMatch: merged.faceMatch` -- the raw merge, routed
   * deliberately around the parse so an older payload would not be rejected for
   * a field it predates. The cost was that the settings form became the only
   * thing enforcing the threshold's 0.2-0.6 range, so a payload written by
   * anything else -- an older bug, a hand edit, a restore from a bad backup --
   * carried an arbitrary threshold straight onto the check-in path. A threshold
   * of 0 matches every face against every reference.
   *
   * The defaults are merged in above, so nothing an old payload *lacks* can
   * fail here; only a value that is genuinely out of range can, and that one
   * falls back to the shipped policy rather than being honoured.
   */
  const face = safeParseFaceMatchPolicy(merged.faceMatch);
  if (!face.success) {
    console.error(
      "[policy] stored faceMatch block is invalid, falling back to defaults",
      {
        organizationId,
        issues: face.error.issues,
      },
    );
  }
  const faceMatch = face.success ? face.data : DEFAULT_FACE_MATCH_POLICY;

  // The merge above fills in anything an older payload predates, so this only
  // fires on a payload that is genuinely wrong — hand-edited, restored from a
  // bad backup, or written by an older bug. It must not throw: this sits on the
  // check-in path, and refusing to evaluate a day is worse than evaluating it by
  // the shipped defaults while somebody is told to look.
  const parsed = safeParseAttendancePolicy(merged);
  if (!parsed.success) {
    console.error(
      "[policy] stored ATTENDANCE policy is invalid, falling back to defaults",
      { organizationId, issues: parsed.error.issues },
    );
    return { ...DEFAULT_ATTENDANCE_RULES, faceMatch };
  }

  return { ...parsed.data, faceMatch };
}

/**
 * Payroll rules for a date.
 *
 * Anything that will not parse is refused rather than silently patched — a
 * malformed payroll policy must not quietly become the defaults and pay everyone
 * the wrong amount.
 */
export async function getPayrollPolicy(
  ctx: AuthContext,
  on?: DateOnly,
): Promise<{ policy: PayrollPolicy; isDefault: boolean; errors: string[] }> {
  requireOrg(ctx);
  const date = on ?? todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const payload = await loadPolicy(ctx.organizationId, "PAYROLL", date);

  if (!payload)
    return { policy: DEFAULT_PAYROLL_POLICY, isDefault: true, errors: [] };

  const parsed = safeParsePayrollPolicy(payload);
  if (!parsed.success) {
    return {
      policy: DEFAULT_PAYROLL_POLICY,
      isDefault: true,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    };
  }

  return { policy: parsed.data as PayrollPolicy, isDefault: false, errors: [] };
}

/**
 * Full-and-final rules for a date.
 *
 * Falls back to the shipped defaults — in which gratuity is *off* — rather than
 * assuming any particular country's statutory position. An organisation that
 * wants gratuity turns it on and states its own terms.
 */
export async function getFnfPolicy(
  ctx: AuthContext,
  on?: DateOnly,
): Promise<{ policy: FnfPolicy; isDefault: boolean; errors: string[] }> {
  requireOrg(ctx);
  const date = on ?? todayInZone(ctx.organization?.timezone ?? "Asia/Kolkata");
  const payload = await loadPolicy(ctx.organizationId, "FNF", date);

  if (!payload)
    return { policy: DEFAULT_FNF_POLICY, isDefault: true, errors: [] };

  const parsed = safeParseFnfPolicy(payload);
  if (!parsed.success) {
    return {
      policy: DEFAULT_FNF_POLICY,
      isDefault: true,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    };
  }

  return { policy: parsed.data as FnfPolicy, isDefault: false, errors: [] };
}

/** Writes a new version rather than editing the current one, so history holds. */
/**
 * Who may rewrite each kind of policy.
 *
 * This lives inside the shared writer rather than in each caller. It used to be
 * nowhere at all — `savePolicyVersion` checked only that a caller had an
 * organisation — which was survivable while the single caller was an AI payroll
 * flow that guarded upstream, and is not survivable now that a settings form
 * reaches it. A missing entry is a refusal, so adding a `PolicyKind` fails
 * closed rather than opening a hole.
 */
const POLICY_WRITE_PERMISSION: Record<PolicyKind, Permission | null> = {
  ATTENDANCE: "attendance.settings.manage",
  PAYROLL: "payroll.rules.manage",
  FNF: "payroll.rules.manage",
  LEAVE: "leave.type.manage",
  WEEKLY_OFF: "org.structure.manage",
  TRAINING: "org.settings.write",
  LETTER: "letter.template.manage",
  SECURITY: "org.settings.write",
};

export async function savePolicyVersion(
  ctx: AuthContext,
  kind: PolicyKind,
  payload: unknown,
  options: {
    effectiveFrom: DateOnly;
    note?: string;
    aiGenerated?: boolean;
    aiPrompt?: string;
  },
): Promise<{ version: number }> {
  requireOrg(ctx);

  const permission = POLICY_WRITE_PERMISSION[kind];
  if (!permission) {
    throw new ForbiddenError(`Policies of kind ${kind} cannot be edited here.`);
  }
  requireWrite(ctx, permission);

  const latest = await prisma.orgPolicyVersion.findFirst({
    where: { organizationId: ctx.organizationId, kind },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (latest?.version ?? 0) + 1;

  // Publishing retires the version it replaces.
  //
  // It did not, and every publish left the old row `active: true` beside the
  // new one. Production carried two active ATTENDANCE policies for one
  // organisation by the time this was found. The read path happens to order by
  // `effectiveFrom desc, version desc` and so still picked the right one, which
  // is why nothing looked broken -- but `active` meant nothing, any query
  // without that exact ordering got a stale answer, and a migration script
  // updating "the active policy" would have had two to choose from.
  //
  // `active` therefore means "the current head", and only that. `loadPolicy`
  // does not filter on it, because a retired version is still the one that
  // was in force on the dates it covered.
  await prisma.$transaction([
    prisma.orgPolicyVersion.updateMany({
      where: { organizationId: ctx.organizationId, kind, active: true },
      data: { active: false },
    }),
    prisma.orgPolicyVersion.create({
      data: {
        organizationId: ctx.organizationId,
        kind,
        version,
        payload: payload as object,
        effectiveFrom: new Date(`${options.effectiveFrom}T00:00:00.000Z`),
        active: true,
        note: options.note ?? null,
        createdById: ctx.userId,
        approvedById: ctx.userId,
        approvedAt: new Date(),
        aiGenerated: options.aiGenerated ?? false,
        aiPrompt: options.aiPrompt ?? null,
      },
    }),
  ]);

  return { version };
}
