import { redirect } from "next/navigation";
import { prisma } from "../db/prisma";
import { UnauthorizedError } from "../errors";
import { MODULES, type ModuleKey, liveModules } from "../features";
import { overridesFrom, scopedModules } from "@/domain/org/moduleScope";
import { type AccessState, resolveAccessState } from "@/domain/billing/seats";
import { type Permission, type SystemRole, effectivePermissions } from "./permissions";
import { currentSession, requireSession, touchSession } from "./session";
import { readImpersonationCookie } from "./impersonation";

/**
 * `AuthContext` is the first argument to every service function.
 *
 * It carries identity, tenant, permissions, live modules and subscription state,
 * all resolved server-side from the session. Nothing in it comes from the
 * request body or query string, which is what makes tenant isolation hold.
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  email: string;
  name: string;
  role: SystemRole;
  /** null only for the platform Superadmin. */
  organizationId: string | null;
  /** The employee record behind this login, if there is one. */
  employeeId: string | null;
  permissions: ReadonlySet<Permission>;
  modules: ReadonlySet<ModuleKey>;
  accessState: AccessState;
  isSuperadmin: boolean;
  /** Superadmin viewing an organisation in audited read-only mode. */
  readOnlyView: boolean;
  /**
   * Set when the platform owner is acting as this person.
   *
   * Everything else in the context is the target's — their role, permissions,
   * modules and organisation — because the whole point is to see and do what
   * they can. This is what keeps the audit log honest: every row written while
   * it is set names the superadmin as well as the account acted as, so a
   * customer's own log never claims their administrator did something Broadmate
   * did.
   */
  impersonating: { byUserId: string; byEmail: string; reason: string; expiresAt: Date } | null;
  /**
   * The account is on a one-time password and has to set its own before it may
   * use anything. Enforced by the layouts, not merely suggested by the login
   * response — a session cookie is already set by then, so an advisory flag is
   * one typed URL away from being ignored.
   */
  mustChangePassword: boolean;
  organization: {
    id: string;
    name: string;
    slug: string;
    timezone: string;
    currency: string;
    status: string;
    seats: number;
    activeEmployees: number;
  } | null;
}

/**
 * Loads the full context for a session. One query per concern rather than a
 * single deep include, so a missing organisation (Superadmin) costs nothing.
 *
 * A superadmin carrying a valid impersonation cookie gets the *target's*
 * context instead of their own, with `impersonating` set. The check that makes
 * that safe is below: the real session is validated first and completely, and
 * the cookie is only consulted once the account behind it has proved to be a
 * SUPERADMIN in the database — not merely to claim the role in a token.
 */
export async function loadContext(session: {
  sub: string;
  sid: string;
  org: string | null;
  role: SystemRole;
}): Promise<AuthContext> {
  const self = await contextForUser(session.sub, session.sid, session.org);
  if (!self.isSuperadmin) return self;

  const claims = await readImpersonationCookie();
  if (!claims) return self;

  /**
   * The cookie only counts for the sign-in that created it.
   *
   * This is the refusal that ends the "I sign in as myself and land on the
   * kiosk" trap: signing out clears `hrms_session` and leaves this cookie
   * alone, so the next sign-in used to be resolved through a visit that had
   * already been walked away from. A new sign-in is a new session id, and a
   * cookie naming the old one is now simply not honoured.
   */
  if (claims.bySession !== session.sid) return self;

  const target = await contextForUser(claims.target, session.sid, undefined).catch(() => null);
  if (!target) return self;

  /**
   * Two refusals, each closing a way the cookie could be worth more than it
   * should be: an organisation it does not actually belong to, and another
   * platform owner.
   *
   * A shared office device used to be refused here as well. It is allowed now,
   * and `startImpersonation` forces `readOnly` for a kiosk whatever the caller
   * asked for -- so the session can look at a reception screen and cannot mark
   * anybody's attendance on it, which was the only thing the refusal was
   * protecting.
   */
  if (target.organizationId !== claims.org) return self;
  if (target.isSuperadmin) return self;

  return {
    ...target,
    readOnlyView: claims.readOnly,
    impersonating: {
      byUserId: self.userId,
      byEmail: self.email,
      reason: claims.reason,
      expiresAt: claims.expiresAt,
    },
  };
}

/**
 * The context one account would have on its own.
 *
 * `expectOrg` is the tenant claim from a session token, checked against the
 * database. It is deliberately absent when loading an impersonation target:
 * there is no token making a claim about them, and their organisation is
 * compared to the cookie's by the caller instead.
 */
async function contextForUser(
  userId: string,
  sessionId: string,
  expectOrg?: string | null,
): Promise<AuthContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      status: true,
      organizationId: true,
      mustChangePassword: true,
      employee: { select: { id: true, designationId: true } },
      permissionGrants: { select: { permission: true, granted: true } },
    },
  });

  if (!user || user.status === "SUSPENDED" || user.status === "DISABLED") {
    throw new UnauthorizedError("Your account is not active. Contact your administrator.");
  }

  // The token's tenant claim must still match the database. If an account is
  // moved or the token is forged, this is where it stops.
  if (expectOrg !== undefined && user.organizationId !== expectOrg) {
    throw new UnauthorizedError("Your session is no longer valid. Please sign in again.");
  }

  const isSuperadmin = user.role === "SUPERADMIN";
  const permissions = effectivePermissions(user.role, user.permissionGrants);

  if (isSuperadmin || !user.organizationId) {
    return {
      userId: user.id,
      sessionId,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: null,
      employeeId: null,
      permissions,
      modules: new Set<ModuleKey>(),
      accessState: "UNMETERED",
      isSuperadmin,
      readOnlyView: false,
      impersonating: null,
      mustChangePassword: user.mustChangePassword,
      organization: null,
    };
  }

  const [
    organization,
    grants,
    settings,
    designationModules,
    userModules,
    activeEmployees,
    pinAuthority,
  ] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: {
        id: true,
        name: true,
        slug: true,
        timezone: true,
        currency: true,
        status: true,
        subscription: {
          select: {
            seats: true,
            billingMode: true,
            status: true,
            currentPeriodEnd: true,
            trialEndsAt: true,
          },
        },
      },
    }),
    prisma.featureGrant.findMany({
      where: { organizationId: user.organizationId },
      select: { featureKey: true, granted: true },
    }),
    prisma.orgModuleSetting.findMany({
      where: { organizationId: user.organizationId },
      select: { moduleKey: true, enabled: true },
    }),
    // The two narrowing layers. Both are small -- one row per module somebody
    // deliberately changed -- and both are read on every request, so they ride
    // along with the queries already here rather than adding a round trip.
    user.employee?.designationId
      ? prisma.designationModuleSetting.findMany({
          where: { designationId: user.employee.designationId },
          select: { moduleKey: true, enabled: true },
        })
      : Promise.resolve([]),
    prisma.userModuleSetting.findMany({
      where: { userId: user.id },
      select: { moduleKey: true, enabled: true },
    }),
    prisma.employee.count({
      where: {
        organizationId: user.organizationId,
        active: true,
        employmentState: { in: ["TRAINING", "PROBATION", "REGULAR", "CONFIRMED", "NOTICE_PERIOD"] },
      },
    }),
    /**
     * Whether somebody has been named to issue attendance PINs.
     *
     * The PIN authority screen grants by role, designation or person, and the
     * navigation, the page guard and the services all read one permission set
     * -- so the answer is folded in here, once per request, for anybody the
     * role bundle does not already cover. A row can only add: an explicit
     * "take away" on the person wins, because that is the one place an
     * administrator said no by name.
     */
    permissions.has("attendance.pin.issue") ||
    user.role === "KIOSK" ||
    user.permissionGrants.some((g) => g.permission === "attendance.pin.issue" && !g.granted)
      ? Promise.resolve(null)
      : prisma.attendancePinAuthority.findFirst({
          where: {
            organizationId: user.organizationId,
            OR: [
              { role: user.role },
              ...(user.employee?.designationId
                ? [{ designationId: user.employee.designationId }]
                : []),
              ...(user.employee?.id ? [{ employeeId: user.employee.id }] : []),
            ],
          },
          select: { id: true },
        }),
  ]);

  if (!organization) throw new UnauthorizedError("Your organisation is no longer available.");
  if (pinAuthority) permissions.add("attendance.pin.issue");

  /**
   * What the organisation has, then narrowed to what this person has.
   *
   * `liveModules` answers for the company -- what the platform granted and what
   * the organisation switched on. The two layers below can only take away from
   * that, never add, so an administrator cannot hand one person a module the
   * company is not paying for.
   */
  const organisationModules = liveModules({
    grants: Object.fromEntries(grants.map((g) => [g.featureKey, g.granted])),
    settings: Object.fromEntries(settings.map((s) => [s.moduleKey, s.enabled])),
  });
  const knownModules = new Set(MODULES.map((m) => m.key as string));
  const modules = scopedModules({
    organisation: organisationModules,
    designation: overridesFrom(designationModules, knownModules),
    user: overridesFrom(userModules, knownModules),
  });

  const accessState = organization.subscription
    ? resolveAccessState(
        {
          billingMode: organization.subscription.billingMode,
          // A PAID organisation nobody has paid for is marked PAST_DUE at
          // provisioning; the date alone said "active" for a whole cycle.
          status: organization.subscription.status,
          currentPeriodEnd: organization.subscription.currentPeriodEnd,
          trialEndsAt: organization.subscription.trialEndsAt,
        },
        new Date(),
      )
    : "TRIAL_EXPIRED";

  return {
    userId: user.id,
    sessionId,
    email: user.email,
    name: user.name,
    role: user.role,
    organizationId: organization.id,
    employeeId: user.employee?.id ?? null,
    permissions,
    modules,
    accessState,
    isSuperadmin: false,
    readOnlyView: false,
    impersonating: null,
    mustChangePassword: user.mustChangePassword,
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      timezone: organization.timezone,
      currency: organization.currency,
      status: organization.status,
      seats: organization.subscription?.seats ?? 0,
      activeEmployees,
    },
  };
}

/** Context for the signed-in user, or throws. Use in route handlers and services. */
export async function requireContext(): Promise<AuthContext> {
  const session = await requireSession();
  const ctx = await loadContext(session);
  void touchSession(session.sid, session.role);
  return ctx;
}

/**
 * Context for a page, or a redirect -- never a thrown 401.
 *
 * **This is the "Something went wrong" every morning.** The layouts catch
 * `requireContext()` and redirect to `/login`, and on a full page load that is
 * what happens. On a client-side navigation -- a sidebar tap, the bottom bar,
 * any `<Link>` -- Next re-renders only the page segment; the layout does not
 * run again. Sixty pages called `requireContext()` directly, so once a session
 * had died, every tap threw `UnauthorizedError` into `error.tsx`, whose two
 * buttons then threw again. In an installed app there is no address bar to
 * reload from. The production log shows it seven times in one day, at eight in
 * the morning, on the pages people open first.
 *
 * `redirect()` from a page is honoured during a soft navigation, so a dead
 * session now lands on the login screen wherever it is noticed.
 *
 * `org` and `superadmin` name which tree the page belongs to. A superadmin
 * whose act-as visit has lapsed still has a session but no organisation, and
 * an organisation page would then throw `ForbiddenError` from the first
 * service it called -- the same error screen by another door. So the page says
 * what it needs and is sent home when the context cannot supply it.
 */
export async function requirePageContext(
  needs: { org?: boolean; superadmin?: boolean } = {},
): Promise<AuthContext> {
  let ctx: AuthContext;
  try {
    ctx = await requireContext();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    throw error;
  }
  if (needs.org && !ctx.organizationId) redirect(ctx.isSuperadmin ? "/platform" : "/login");
  if (needs.superadmin && !ctx.isSuperadmin) redirect("/dashboard");
  return ctx;
}

/** Context if signed in, else null. Use in layouts that render for guests too. */
export async function optionalContext(): Promise<AuthContext | null> {
  const session = await currentSession();
  if (!session) return null;
  try {
    return await loadContext(session);
  } catch {
    return null;
  }
}

/**
 * `superadminReadOnlyContext` used to live here, and was called from nowhere.
 *
 * It derived a pinned, read-filtered context from a superadmin's own — a good
 * shape, but nothing ever produced one, so `readOnlyView` was permanently false
 * and both the amber banner and the write guard built for it were unreachable.
 * Impersonation replaces it and finally sets that flag, from the cookie's
 * `readOnly` claim.
 */
