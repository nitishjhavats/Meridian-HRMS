import type { OrgStatus, Prisma } from "@prisma/client";
import { defaultOnHolidays } from "@/domain/org/holidayCatalogue";
import { prisma } from "@/lib/db/prisma";
import type { AuthContext } from "@/lib/auth/context";
import { requirePermission, requireSuperadmin } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { writeAudit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { hashPassword, generateTemporaryPassword } from "@/lib/auth/password";
import { signInUrl } from "@/services/employees/credentials";
import { MODULES, type ModuleKey, isModuleKey, resolveModules } from "@/lib/features";
import { DEFAULT_ATTENDANCE_POLICY } from "@/domain/attendance/policy";
import { withoutIssuedCode } from "@/services/billing/customerOrder";
import { DEFAULT_FACE_MATCH_POLICY } from "@/domain/attendance/faceMatch";
import { DEFAULT_PAYROLL_POLICY } from "@/domain/payroll/policy";
import { summariseSeats } from "@/domain/billing/seats";
import { normaliseCodePrefix, suggestCodePrefix } from "@/domain/employees/code";

/**
 * Creating and governing organisations.
 *
 * A new organisation is created complete: subscription, feature grants, module
 * settings, default shift, week-off pattern, leave types, salary components and
 * policy versions all land in one transaction. Half-provisioned tenants are the
 * source of most "why is this screen empty" support tickets.
 */

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  status: OrgStatus;
  billingMode: string;
  seats: number;
  activeEmployees: number;
  utilisationPercent: number;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  createdAt: Date;
  users: number;
}

/**
 * A page of organisations, with the total so a pager can be drawn.
 *
 * `listOrganizations` returns everything and always has, which was fine while
 * the only caller was a full-page list. The dashboard now shows them beside the
 * recent payments, where "everything" is not a shape a card can hold.
 *
 * Paging is offset-based rather than cursor-based on purpose: the caller wants
 * page numbers and a total, the ordering is stable, and nobody is going to have
 * enough organisations for the offset to cost anything.
 */
export async function listOrganizationsPage(
  ctx: AuthContext,
  options: { page?: number; pageSize?: number; status?: OrgStatus[]; search?: string } = {},
): Promise<{ rows: OrganizationRow[]; total: number; page: number; pageSize: number }> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.read");

  const pageSize = PAGE_SIZES.includes(options.pageSize as never)
    ? options.pageSize!
    : PAGE_SIZES[1]!;
  const rows = await listOrganizations(ctx, options);
  // Filtered in the same call rather than counted separately, so the total and
  // the rows can never describe different sets.
  const total = rows.length;
  const page = Math.min(Math.max(1, options.page ?? 1), Math.max(1, Math.ceil(total / pageSize)));
  const start = (page - 1) * pageSize;

  return { rows: rows.slice(start, start + pageSize), total, page, pageSize };
}

/** The page sizes the dashboard offers. */
export const PAGE_SIZES = [5, 10, 25, 50, 100] as const;

export async function listOrganizations(
  ctx: AuthContext,
  filters: { status?: OrgStatus[]; search?: string } = {},
): Promise<OrganizationRow[]> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.read");

  const organizations = await prisma.organization.findMany({
    where: {
      ...(filters.status?.length ? { status: { in: filters.status } } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: "insensitive" } },
              { slug: { contains: filters.search, mode: "insensitive" } },
              { email: { contains: filters.search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      subscription: true,
      _count: { select: { users: true } },
    },
  });

  const activeCounts = await prisma.employee.groupBy({
    by: ["organizationId"],
    where: {
      active: true,
      employmentState: { in: ["TRAINING", "PROBATION", "REGULAR", "CONFIRMED", "NOTICE_PERIOD"] },
    },
    _count: { _all: true },
  });
  const activeByOrg = new Map(activeCounts.map((row) => [row.organizationId, row._count._all]));

  return organizations.map((org) => {
    const active = activeByOrg.get(org.id) ?? 0;
    const seats = org.subscription?.seats ?? 0;
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      city: org.city,
      status: org.status,
      billingMode: org.subscription?.billingMode ?? "TRIAL",
      seats,
      activeEmployees: active,
      utilisationPercent: summariseSeats(seats, active).utilisationPercent,
      currentPeriodEnd: org.subscription?.currentPeriodEnd ?? null,
      trialEndsAt: org.subscription?.trialEndsAt ?? null,
      createdAt: org.createdAt,
      users: org._count.users,
    };
  });
}

export async function getOrganization(ctx: AuthContext, organizationId: string) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.read");

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      subscription: true,
      featureGrants: true,
      moduleSettings: true,
      subscriptionHistory: { orderBy: { createdAt: "desc" }, take: 10 },
      paymentOrders: { orderBy: { createdAt: "desc" }, take: 10 },
      _count: { select: { employees: true, users: true } },
    },
  });
  if (!org) throw new NotFoundError("That organisation");

  const activeEmployees = await prisma.employee.count({
    where: {
      organizationId,
      active: true,
      employmentState: { in: ["TRAINING", "PROBATION", "REGULAR", "CONFIRMED", "NOTICE_PERIOD"] },
    },
  });

  const grants = Object.fromEntries(org.featureGrants.map((g) => [g.featureKey, g.granted]));
  const settings = Object.fromEntries(org.moduleSettings.map((s) => [s.moduleKey, s.enabled]));

  return {
    ...org,
    // The issued code stays on the server here too (see withoutIssuedCode).
    paymentOrders: org.paymentOrders.map(withoutIssuedCode),
    activeEmployees,
    seats: summariseSeats(org.subscription?.seats ?? 0, activeEmployees),
    modules: resolveModules({ grants, settings }),
  };
}

/**
 * Everyone in an organisation, whether or not they can sign in.
 *
 * The People list used to be `organization.users`, which meant it showed the
 * owner, the office devices, and only those employees somebody had explicitly
 * given a login to -- so most of a customer's staff were invisible from the
 * platform console and could not be signed in as. Impersonation never had a
 * role allow-list; the people simply were not on the screen.
 *
 * It also had no `take` and no filter, which is the thing that actually breaks
 * on a real tenant.
 *
 * Two lists rather than one: an employee row and a bare login are different
 * things and mixing them into one paginated stream makes both harder to read.
 */
export interface OrgPersonRow {
  employeeId: string | null;
  userId: string | null;
  name: string;
  email: string | null;
  employeeCode: string | null;
  designation: string | null;
  role: string | null;
  status: string | null;
  lastLoginAt: Date | null;
  employmentState: string | null;
  active: boolean;
}

export interface OrgPeoplePage {
  employees: OrgPersonRow[];
  /** Logins with no employee record: the owner, and office devices. */
  accounts: OrgPersonRow[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
}

const PEOPLE_PAGE_SIZE = 25;

export async function listOrganizationPeople(
  ctx: AuthContext,
  organizationId: string,
  options: { search?: string; page?: number } = {},
): Promise<OrgPeoplePage> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.read");

  const search = (options.search ?? "").trim();
  const page = Math.max(1, Math.floor(options.page ?? 1));

  const where: Prisma.EmployeeWhereInput = {
    organizationId,
    ...(search
      ? {
          OR: [
            { firstName: { contains: search, mode: "insensitive" } },
            { lastName: { contains: search, mode: "insensitive" } },
            { employeeCode: { contains: search, mode: "insensitive" } },
            { workEmail: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, rows, accounts] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        workEmail: true,
        personalEmail: true,
        active: true,
        employmentState: true,
        designation: { select: { title: true } },
        user: {
          select: { id: true, email: true, role: true, status: true, lastLoginAt: true },
        },
      },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      skip: (page - 1) * PEOPLE_PAGE_SIZE,
      take: PEOPLE_PAGE_SIZE,
    }),
    // Small and never paginated: an organisation has one owner and a handful of
    // devices, and hiding either behind a page would be its own bug.
    prisma.user.findMany({
      where: { organizationId, employee: { is: null } },
      select: { id: true, name: true, email: true, role: true, status: true, lastLoginAt: true },
      orderBy: { role: "asc" },
    }),
  ]);

  return {
    total,
    page,
    pageSize: PEOPLE_PAGE_SIZE,
    search,
    employees: rows.map((e) => ({
      employeeId: e.id,
      userId: e.user?.id ?? null,
      // Off the employee record, never off a login: an employee without one
      // still has a name, and reading it from `user` is what put a dash on
      // people's payslips.
      name: [e.firstName, e.lastName].filter(Boolean).join(" "),
      email: e.user?.email ?? e.workEmail ?? e.personalEmail ?? null,
      employeeCode: e.employeeCode,
      designation: e.designation?.title ?? null,
      role: e.user?.role ?? null,
      status: e.user?.status ?? null,
      lastLoginAt: e.user?.lastLoginAt ?? null,
      employmentState: e.employmentState,
      active: e.active,
    })),
    accounts: accounts.map((u) => ({
      employeeId: null,
      userId: u.id,
      name: u.name,
      email: u.email,
      employeeCode: null,
      designation: null,
      role: u.role,
      status: u.status,
      lastLoginAt: u.lastLoginAt,
      employmentState: null,
      active: u.status === "ACTIVE",
    })),
  };
}

export interface CreateOrganizationInput {
  name: string;
  /** Three letters every employee code here starts with. Derived from the name when absent. */
  employeeCodePrefix?: string;
  legalName?: string;
  slug: string;
  email?: string;
  phone?: string;
  website?: string;
  industry?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  timezone?: string;
  currency?: string;
  /**
   * How many people this organisation may activate.
   *
   * Optional on purpose. The Superadmin can settle commercials at creation, or
   * leave them and let the organisation's own admin buy seats from `/billing`.
   * Blank means zero, which `canActivateEmployee` already refuses with "No seats
   * have been purchased yet" rather than silently admitting everybody.
   */
  seats?: number;
  /** Blank is a trial: usable immediately, decided later. */
  billingMode?: "TRIAL" | "PAID" | "FREE_INTERNAL";
  /** Renewal period for a paying organisation. Blank is annual. */
  billingCycle?: "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL";
  trialDays?: number;
  /**
   * Set when a paying organisation has already settled up somewhere else — a
   * bank transfer, a cheque, an invoice raised outside the product. Without it a
   * PAID organisation starts PENDING_PAYMENT and waits for the UPI flow.
   */
  alreadyPaid?: boolean;
  grantedModules?: ModuleKey[];
  /** The first Organisation Owner account. */
  owner: { name: string; email: string; phone?: string };
  /** Defaults applied to the new tenant. */
  workingHours?: { start: string; end: string; breakMinutes: number };
  weeklyOffDays?: number[];
}

/**
 * Everything a usable tenant needs, in one transaction.
 *
 * Shared by the Superadmin's "create organisation" screen and by public
 * sign-up. Keeping one implementation is the point: a tenant provisioned by one
 * route and not the other is how "why is this screen empty" bugs start.
 *
 * It takes no `AuthContext` — the caller has already decided this is allowed.
 */
export interface ProvisionTenantInput extends CreateOrganizationInput {
  /** Null for self-service sign-up, where nobody authorised it but the signer. */
  actorId: string | null;
  passwordHash: string;
  /** False when the owner chose the password themselves. */
  mustChangePassword: boolean;
}

/**
 * The slug rule, in one place.
 *
 * It decides `/o/<slug>`, so it has to be URL-safe, and it is now editable
 * after creation -- where `updateOrganization` used to write whatever it was
 * handed, because the only validation lived inline in `provisionTenant`.
 */
export async function normaliseSlug(
  input: string,
  options: { exceptOrganizationId?: string } = {},
): Promise<string> {
  const slug = input.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
    throw new ValidationError(
      "The slug must be 3–50 characters of lowercase letters, numbers and hyphens.",
    );
  }
  const clash = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (clash && clash.id !== options.exceptOrganizationId) {
    throw new ConflictError("An organisation already uses that slug.");
  }

  /**
   * And an address somebody has left behind is still theirs.
   *
   * Old addresses keep resolving, so handing one to a second organisation would
   * make `/o/acme` point at two companies -- and the one it resolved to would
   * depend on which query ran first. The unique index on the history table
   * refuses this at the database too; this is the message a person reads.
   */
  const previous = await prisma.organizationSlug.findUnique({
    where: { slug },
    select: { organizationId: true },
  });
  if (previous && previous.organizationId !== options.exceptOrganizationId) {
    throw new ConflictError(
      "Another organisation used that address before. Old addresses keep working, so it cannot be reused.",
    );
  }

  return slug;
}

export async function provisionTenant(input: ProvisionTenantInput) {
  const slug = await normaliseSlug(input.slug);

  const ownerEmail = input.owner.email.trim().toLowerCase();
  if (await prisma.user.findFirst({ where: { email: ownerEmail } })) {
    throw new ConflictError("An account already uses that email address.");
  }
  const passwordHash = input.passwordHash;

  const now = new Date();
  const pricing = await prisma.platformSetting.findUnique({ where: { id: "singleton" } });

  // Blank means "the organisation will decide" — a trial, usable immediately,
  // with no seats until somebody buys them.
  const billingMode = input.billingMode ?? "TRIAL";
  const billingCycle = input.billingCycle ?? "ANNUAL";
  const seats = Math.max(0, input.seats ?? 0);

  const trialDays =
    billingMode === "TRIAL" ? (input.trialDays ?? pricing?.defaultTrialDays ?? 14) : 0;

  const periodEnd = new Date(now);
  if (billingMode === "TRIAL") {
    periodEnd.setDate(periodEnd.getDate() + trialDays);
  } else if (billingMode === "PAID" && billingCycle === "MONTHLY") {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  } else if (billingMode === "PAID" && billingCycle === "QUARTERLY") {
    periodEnd.setMonth(periodEnd.getMonth() + 3);
  } else if (billingMode === "PAID" && billingCycle === "HALF_YEARLY") {
    periodEnd.setMonth(periodEnd.getMonth() + 6);
  } else {
    periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  }

  // A paying organisation normally waits for its first approved payment. It does
  // not when the money already changed hands elsewhere and the Superadmin says so.
  const paidUpFront = billingMode === "PAID" && input.alreadyPaid === true;
  const granted = new Set(input.grantedModules ?? MODULES.filter((m) => m.defaultGranted).map((m) => m.key));

  const organization = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: {
        name: input.name.trim(),
        legalName: input.legalName?.trim() || null,
        slug,
        // A suggestion from the name rather than "EMP", so a new customer's
        // people are not numbered as though they worked for everybody else.
        employeeCodePrefix: input.employeeCodePrefix
          ? normaliseCodePrefix(input.employeeCodePrefix)
          : suggestCodePrefix(input.name),
        email: input.email?.trim() || null,
        phone: input.phone?.trim() || null,
        website: input.website?.trim() || null,
        industry: input.industry?.trim() || null,
        addressLine1: input.addressLine1?.trim() || null,
        city: input.city?.trim() || null,
        state: input.state?.trim() || null,
        country: input.country?.trim() || "India",
        postalCode: input.postalCode?.trim() || null,
        timezone: input.timezone || "Asia/Kolkata",
        currency: input.currency || "INR",
        // A trial or internal organisation is usable immediately; a paying one
        // waits for its first approved payment unless it has already paid.
        status: billingMode === "PAID" && !paidUpFront ? "PENDING_PAYMENT" : "ACTIVE",
        seatLimit: seats,
        createdById: input.actorId,
      },
    });

    await tx.subscription.create({
      data: {
        organizationId: org.id,
        seats,
        status:
          billingMode === "PAID" ? (paidUpFront ? "ACTIVE" : "PAST_DUE") : "TRIAL",
        billingMode,
        billingCycle,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        trialEndsAt: billingMode === "TRIAL" ? periodEnd : null,
        nextBillingDate: periodEnd,
        pricePerUserPaise: pricing?.pricePerUserPaise ?? 5_900,
      },
    });

    await tx.featureGrant.createMany({
      data: MODULES.map((m) => ({
        organizationId: org.id,
        featureKey: m.key,
        granted: m.core || granted.has(m.key),
        grantedById: input.actorId,
      })),
    });

    await tx.orgModuleSetting.createMany({
      data: MODULES.map((m) => ({
        organizationId: org.id,
        moduleKey: m.key,
        enabled: m.core || (granted.has(m.key) && m.defaultEnabled),
      })),
    });

    const owner = await tx.user.create({
      data: {
        organizationId: org.id,
        email: ownerEmail,
        name: input.owner.name.trim(),
        phone: input.owner.phone?.trim() || null,
        passwordHash,
        role: "ORG_OWNER",
        status: "ACTIVE",
        mustChangePassword: input.mustChangePassword,
        passwordChangedAt: now,
      },
    });

    // --- sensible defaults so no screen opens empty
    const hours = input.workingHours ?? { start: "09:00", end: "18:00", breakMinutes: 60 };
    const shift = await tx.shift.create({
      data: {
        organizationId: org.id,
        name: "General Shift",
        startTime: hours.start,
        endTime: hours.end,
        breakMinutes: hours.breakMinutes,
        graceMinutes: DEFAULT_ATTENDANCE_POLICY.graceMinutes,
        isDefault: true,
      },
    });

    const offDays = input.weeklyOffDays?.length ? input.weeklyOffDays : [0];
    const weeklyOff = await tx.weeklyOffPattern.create({
      data: {
        organizationId: org.id,
        name: offDays.length > 1 ? "Weekend off" : "Sunday off",
        type: offDays.length > 1 ? "MULTIPLE" : "FIXED",
        config: { type: offDays.length > 1 ? "MULTIPLE" : "FIXED", days: offDays },
        isDefault: true,
      },
    });

    /**
      * Leave types arrive **switched off**, except the weekly rest day.
      *
      * The seeded five used to arrive on, with numbers nobody had chosen --
      * twelve casual, eight sick, fifteen earned -- and an organisation whose
      * policy is different discovered that on the day somebody applied for
      * leave they did not have. Off is the honest starting state: the names
      * and the shape are there as a starting point, and each one appears to
      * employees only once an administrator has said how many days it is worth,
      * how it accrues and whether it is paid.
      *
      * The week off is the exception because every organisation has one and
      * nobody has to decide what it means. It is the *on-demand* one: a rest
      * day can never be booked on a pattern rest day, so these four a month
      * were always on top of the pattern, and the name now says so. Capped at
      * four in any one month as well as accruing four, because a bank of rest
      * days that could be spent eight in one month is not a week off. Paid —
      * and an administrator can change the count, the cap, the frequency and
      * the paid flag, or switch it off entirely, like any other.
      */
    await tx.leaveType.createMany({
      data: [
        { code: "WEEK_OFF", name: "On-demand Week Off", annualAllocation: 48, accrualMode: "MONTHLY", monthlyAccrual: 4, maxPerMonth: 4, isWeekOff: true, active: true, color: "#64748b" },
        { code: "CL", name: "Casual Leave", annualAllocation: 12, accrualMode: "MONTHLY", monthlyAccrual: 1, active: false, color: "#3b82f6" },
        { code: "SL", name: "Sick Leave", annualAllocation: 8, accrualMode: "ANNUAL", active: false, color: "#ef4444" },
        { code: "EL", name: "Earned Leave", annualAllocation: 15, accrualMode: "MONTHLY", monthlyAccrual: 1.25, carryForward: true, maxCarryForward: 10, active: false, color: "#10b981" },
        { code: "LWP", name: "Leave Without Pay", annualAllocation: 0, accrualMode: "NONE", paid: false, active: false, color: "#6b7280" },
        { code: "COMP_OFF", name: "Compensatory Off", annualAllocation: 0, accrualMode: "NONE", isCompOff: true, active: false, color: "#8b5cf6" },
      ].map((lt) => ({ ...lt, organizationId: org.id })),
    });

    await tx.salaryComponent.createMany({
      data: DEFAULT_PAYROLL_POLICY.components.map((c) => ({
        organizationId: org.id,
        code: c.code,
        name: c.name,
        kind: c.kind,
        calc: c.calc as object,
        prorated: c.prorated,
        taxable: c.taxable,
        showOnSlip: c.showOnSlip,
        sortOrder: c.sortOrder,
      })),
    });

    await tx.orgPolicyVersion.createMany({
      data: [
        {
          organizationId: org.id,
          kind: "PAYROLL",
          version: 1,
          payload: DEFAULT_PAYROLL_POLICY as unknown as object,
          effectiveFrom: now,
          approvedById: input.actorId,
          approvedAt: now,
        },
        {
          organizationId: org.id,
          kind: "ATTENDANCE",
          version: 1,
          payload: {
            ...DEFAULT_ATTENDANCE_POLICY,
            shift: { ...DEFAULT_ATTENDANCE_POLICY.shift, start: hours.start, end: hours.end, breakMinutes: hours.breakMinutes },
            // Written explicitly, because an absent block means "this policy
            // predates face matching" and is read as the old permissive
            // behaviour. A new organisation has no employees yet, so the strict
            // default costs nobody anything and is what they should start on.
            faceMatch: DEFAULT_FACE_MATCH_POLICY,
          } as unknown as object,
          effectiveFrom: now,
        },
      ],
    });

    // --- the owner is a person, not only a login
    //
    // Without this a brand-new organisation is a dead end: the owner signs in
    // with `ctx.employeeId === null`, and "My attendance", "My leave" and "My
    // salary" all refuse before they render. They are also the first row in the
    // directory, which is what makes the employee screens make sense on day one.
    const department = await tx.department.create({
      data: { organizationId: org.id, name: "General", code: "GEN" },
    });
    const designation = await tx.designation.create({
      data: { organizationId: org.id, title: "Owner", level: 1 },
    });

    /**
     * The three gazetted national days, this year and next.
     *
     * Provisioning seeded no holidays at all -- deliberately, because a
     * festival date is regional and guessing one marks somebody absent on a day
     * their office was shut. These three are not that: Republic Day,
     * Independence Day and Gandhi Jayanti are the same date everywhere and every
     * establishment is closed. A calendar without them is a calendar that says
     * 26 January is a working day.
     *
     * Two years, because a calendar that runs out in December is a calendar
     * somebody discovers is empty on the 2nd of January. After that the
     * maintenance job keeps it a year ahead. `skipDuplicates` rather than a
     * check: the unique key is (organisation, name, date), and racing with a
     * hand-typed holiday of the same name should lose quietly.
     *
     * They arrive on and can be switched off. Off is a real answer -- a plant
     * running a shift on Republic Day exists -- and the job will not put one
     * back, because it never revisits a year it has already seeded.
     */
    const seedYear = new Date().getUTCFullYear();
    await tx.holiday.createMany({
      data: [...defaultOnHolidays(seedYear), ...defaultOnHolidays(seedYear + 1)].map((h) => ({
        organizationId: org.id,
        name: h.name,
        date: new Date(`${h.date}T00:00:00.000Z`),
        type: "PUBLIC" as const,
        paid: true,
        optional: false,
      })),
      skipDuplicates: true,
    });

    // How far the calendar has been filled. The yearly job reads this and
    // seeds forward from it, once per year -- so a holiday somebody switched
    // off stays off, because a year already seeded is never revisited.
    await tx.organization.update({
      where: { id: org.id },
      data: { holidaysSeededThrough: seedYear + 1 },
    });

    // No work location: it needs real coordinates, and inventing them would make
    // the geofence quietly measure against the wrong place — worse than having
    // none, which the check-in path already handles. The screens that need one
    // ask for it.
    const ownerName = input.owner.name.trim();
    const [firstName, ...rest] = ownerName.split(/\s+/);

    const ownerEmployee = await tx.employee.create({
      data: {
        organizationId: org.id,
        userId: owner.id,
        employeeCode: "EMP001",
        firstName: firstName || ownerName || "Owner",
        lastName: rest.join(" ") || null,
        workEmail: ownerEmail,
        phone: input.owner.phone?.trim() || null,
        joiningDate: now,
        departmentId: department.id,
        designationId: designation.id,
        shiftId: shift.id,
        weeklyOffPatternId: weeklyOff.id,
        employmentState: "CONFIRMED",
      },
    });

    await tx.employmentStateChange.create({
      data: {
        employeeId: ownerEmployee.id,
        fromState: null,
        toState: "CONFIRMED",
        effectiveOn: now,
        reason: "Organisation created",
        actorId: input.actorId,
      },
    });

    return { org, owner };
  });

  return { organization: organization.org, owner: organization.owner, ownerEmail };
}

export async function createOrganization(ctx: AuthContext, input: CreateOrganizationInput) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.create");

  const temporaryPassword = generateTemporaryPassword();
  const result = await provisionTenant({
    ...input,
    actorId: ctx.userId,
    passwordHash: await hashPassword(temporaryPassword),
    // A password somebody else generated must be replaced on first sign-in.
    mustChangePassword: true,
  });

  await writeAudit(ctx, {
    action: "org.created",
    entityType: "Organization",
    entityId: result.organization.id,
    organizationId: result.organization.id,
    after: {
      name: result.organization.name,
      slug: result.organization.slug,
      seats: result.organization.seatLimit,
      billingMode: input.billingMode ?? "TRIAL",
      billingCycle: input.billingCycle ?? "ANNUAL",
      // Worth recording: it is the difference between an organisation that can
      // work today and one waiting on a payment queue.
      alreadyPaid: input.alreadyPaid === true,
      commercialsLeftToOrg: input.seats == null || input.billingMode == null,
    },
  });

  // The password is returned once, to the Superadmin, to pass on out of band.
  // The sign-in link goes with it: "hrms.broadmate.org" is a product they have
  // never heard of, `/o/<slug>` is their own company's door.
  return {
    organization: result.organization,
    owner: {
      email: result.ownerEmail,
      temporaryPassword,
      signInUrl: signInUrl(result.organization.slug),
    },
  };
}

export async function updateOrganization(
  ctx: AuthContext,
  organizationId: string,
  patch: Partial<Prisma.OrganizationUpdateInput> & { seats?: number },
) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.update");

  const before = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { subscription: true },
  });
  if (!before) throw new NotFoundError("That organisation");

  const { seats, ...orgPatch } = patch;

  // A slug reaching this function used to be written unchecked, which is how a
  // customer's front door could become "/o/ " or collide with somebody else's.
  if (typeof orgPatch.slug === "string") {
    orgPatch.slug = await normaliseSlug(orgPatch.slug, { exceptOrganizationId: organizationId });
  }
  // Same reason: the column is VARCHAR(3), so an unchecked value is a database
  // error rather than a message anybody can act on.
  if (typeof orgPatch.employeeCodePrefix === "string") {
    orgPatch.employeeCodePrefix = normaliseCodePrefix(orgPatch.employeeCodePrefix);
  }

  const updated = await prisma.$transaction(async (tx) => {
    /**
     * The address being left is written down before the move, in the same
     * transaction as the move.
     *
     * Outside it, a failure halfway would leave an organisation at a new
     * address with nothing remembering the old one -- and the old one is what
     * is printed on emails and baked into every installed app.
     *
     * `skipDuplicates`, because an organisation that renames back to an address
     * it once had already has the row.
     */
    if (typeof orgPatch.slug === "string" && orgPatch.slug !== before.slug) {
      await tx.organizationSlug.createMany({
        data: [{ organizationId, slug: before.slug }],
        skipDuplicates: true,
      });
      // And the address it is moving *to* stops being a past address, or the
      // history would claim a slug the organisation is now living at.
      await tx.organizationSlug.deleteMany({ where: { organizationId, slug: orgPatch.slug } });
    }

    const org = await tx.organization.update({
      where: { id: organizationId },
      data: { ...orgPatch, ...(seats != null ? { seatLimit: seats } : {}) },
    });

    if (seats != null && before.subscription) {
      await tx.subscription.update({
        where: { organizationId },
        data: { seats },
      });
      await tx.subscriptionHistory.create({
        data: {
          organizationId,
          previousSeats: before.subscription.seats,
          newSeats: seats,
          previousPeriodEnd: before.subscription.currentPeriodEnd,
          newPeriodEnd: before.subscription.currentPeriodEnd,
          amountPaise: 0,
          note: "Adjusted by the platform owner",
          createdById: ctx.userId,
        },
      });
    }

    return org;
  });

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: organizationId,
    organizationId,
    before: { name: before.name, seatLimit: before.seatLimit, status: before.status },
    after: { name: updated.name, seatLimit: updated.seatLimit, status: updated.status },
  });

  return updated;
}

export async function setOrganizationStatus(
  ctx: AuthContext,
  organizationId: string,
  status: OrgStatus,
  reason?: string,
) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.suspend");

  const before = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!before) throw new NotFoundError("That organisation");

  const suspending = status === "SUSPENDED" || status === "ARCHIVED";
  if (suspending && !reason?.trim()) {
    throw new ValidationError("Give a reason — it is shown in the audit log and to support.");
  }

  const updated = await prisma.organization.update({
    where: { id: organizationId },
    data: {
      status,
      suspendedAt: suspending ? new Date() : null,
      suspendedReason: suspending ? reason!.trim() : null,
    },
  });

  // Suspension takes effect immediately: existing sessions are cut, not left to
  // expire on their own.
  if (suspending) {
    const users = await prisma.user.findMany({
      where: { organizationId },
      select: { id: true },
    });
    await prisma.session.updateMany({
      where: { userId: { in: users.map((u) => u.id) }, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: ctx.userId },
    });
  }

  await writeAudit(ctx, {
    action: suspending ? "org.suspended" : "org.activated",
    entityType: "Organization",
    entityId: organizationId,
    organizationId,
    before: { status: before.status },
    after: { status, reason: reason ?? null },
  });

  if (!suspending) {
    await notify.toOrgRoles(organizationId, ["ORG_OWNER", "ADMIN"], {
      type: "org.activated",
      title: "Your organisation is active again",
      body: "Full access has been restored.",
      link: "/dashboard",
    });
  }

  return updated;
}

/** Level 1 of the feature system: what this organisation is *allowed* to use. */
export async function setFeatureGrants(
  ctx: AuthContext,
  organizationId: string,
  grants: Record<string, boolean>,
) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.feature.grant");

  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw new NotFoundError("That organisation");

  const entries = Object.entries(grants).filter(([key]) => isModuleKey(key));
  if (entries.length === 0) throw new ValidationError("No recognised modules were supplied.");

  await prisma.$transaction(
    entries.map(([featureKey, granted]) =>
      prisma.featureGrant.upsert({
        where: { organizationId_featureKey: { organizationId, featureKey } },
        create: { organizationId, featureKey, granted, grantedById: ctx.userId },
        update: { granted, grantedById: ctx.userId },
      }),
    ),
  );

  // Revoking a grant must also switch the module off, otherwise restoring the
  // grant later would silently turn it back on.
  const revoked = entries.filter(([, granted]) => !granted).map(([key]) => key);
  if (revoked.length > 0) {
    await prisma.orgModuleSetting.updateMany({
      where: { organizationId, moduleKey: { in: revoked } },
      data: { enabled: false },
    });
  }

  await writeAudit(ctx, {
    action: "org.feature_granted",
    entityType: "Organization",
    entityId: organizationId,
    organizationId,
    after: grants,
  });

  return getOrganization(ctx, organizationId);
}

/* -------------------------------------------------------------------------- */
/*  Subscription, after the fact                                               */
/* -------------------------------------------------------------------------- */

export interface SubscriptionPatch {
  seats?: number;
  billingMode?: "TRIAL" | "PAID" | "FREE_INTERNAL";
  billingCycle?: "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL";
  /** When the current licence runs out. YYYY-MM-DD. */
  currentPeriodEnd?: string;
  /** Paid up, or waiting on a payment. */
  active?: boolean;
}

/**
 * Changing an organisation's licence after it was created.
 *
 * Commercials move: a trial gets extended while a purchase order works its way
 * through somebody's finance team, seats go up mid-year, a cycle changes at
 * renewal. Setting all of it at creation and never again would mean editing the
 * database by hand, which is how a payroll system's billing quietly stops
 * matching what was agreed.
 *
 * The expiry is a plain date the Superadmin sets, not something derived from the
 * cycle. The cycle says how long a *renewal* runs; this says when the current one
 * ends, and those are different questions — an organisation that paid late has a
 * period that does not line up with its cycle, and pretending otherwise would
 * either cut them off early or give them a free month.
 */
export async function updateSubscription(
  ctx: AuthContext,
  organizationId: string,
  patch: SubscriptionPatch,
) {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.update");

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, status: true },
  });
  if (!organization) throw new NotFoundError("That organisation");

  const existing = await prisma.subscription.findUnique({
    where: { organizationId },
  });
  if (!existing) throw new NotFoundError("That organisation's subscription");

  let periodEnd: Date | undefined;
  if (patch.currentPeriodEnd) {
    periodEnd = new Date(`${patch.currentPeriodEnd}T00:00:00.000Z`);
    if (Number.isNaN(periodEnd.getTime())) {
      throw new ValidationError("That is not a date.");
    }
    if (periodEnd <= existing.currentPeriodStart) {
      throw new ValidationError("The licence has to end after the period it started in.");
    }
  }

  const billingMode = patch.billingMode ?? existing.billingMode;
  const seats = patch.seats ?? existing.seats;
  if (seats < 0) throw new ValidationError("Seats cannot be negative.");

  // Fewer seats than people already active is a decision, not an accident, so it
  // is refused rather than silently leaving the organisation over its limit.
  if (patch.seats !== undefined && billingMode !== "FREE_INTERNAL") {
    const active = await prisma.employee.count({ where: { organizationId, active: true } });
    if (seats < active) {
      throw new ConflictError(
        `${organization.name} has ${active} active employees. Deactivate some before cutting to ${seats} seats.`,
      );
    }
  }

  const status =
    patch.active === undefined
      ? existing.status
      : patch.active
        ? ("ACTIVE" as const)
        : billingMode === "TRIAL"
          ? ("TRIAL" as const)
          : ("PAST_DUE" as const);

  const updated = await prisma.$transaction(async (tx) => {
    const subscription = await tx.subscription.update({
      where: { organizationId },
      data: {
        seats,
        billingMode,
        ...(patch.billingCycle ? { billingCycle: patch.billingCycle } : {}),
        ...(periodEnd
          ? {
              currentPeriodEnd: periodEnd,
              nextBillingDate: periodEnd,
              // A trial's end date and its licence end are the same thing; a paid
              // organisation has no trial to extend.
              ...(billingMode === "TRIAL" ? { trialEndsAt: periodEnd } : {}),
            }
          : {}),
        status,
      },
    });

    // The organisation's own status follows: an organisation waiting on payment
    // is read-only, and one that has paid should not stay that way.
    await tx.organization.update({
      where: { id: organizationId },
      data: {
        seatLimit: seats,
        ...(patch.active === true && organization.status === "PENDING_PAYMENT"
          ? { status: "ACTIVE" as const }
          : {}),
      },
    });

    return subscription;
  });

  await writeAudit(ctx, {
    action: "org.updated",
    entityType: "Organization",
    entityId: organizationId,
    organizationId,
    before: {
      seats: existing.seats,
      billingMode: existing.billingMode,
      billingCycle: existing.billingCycle,
      currentPeriodEnd: existing.currentPeriodEnd,
      status: existing.status,
    },
    after: {
      seats: updated.seats,
      billingMode: updated.billingMode,
      billingCycle: updated.billingCycle,
      currentPeriodEnd: updated.currentPeriodEnd,
      status: updated.status,
    },
  });

  return updated;
}


/**
 * Who can be signed in as, inside one organisation.
 *
 * The dashboard's impersonate button opens this rather than picking somebody:
 * an owner is usually the right answer and not always, and choosing silently
 * would mean the platform owner sometimes lands in an account with the wrong
 * view of the problem they are debugging.
 *
 * Only accounts that *have* a login — there is no session to mint otherwise, and
 * offering a control that cannot work is worse than saying so. Sorted by how
 * much they can see, because that is the order somebody debugging reaches for.
 */
export interface ImpersonationTarget {
  userId: string;
  name: string;
  email: string;
  role: string;
  employeeCode: string | null;
}

const ROLE_ORDER = [
  "ORG_OWNER",
  "ADMIN",
  "HR_MANAGER",
  "MANAGER",
  "TEAM_LEAD",
  "SUPERVISOR",
  "TEAM_MEMBER",
  "KIOSK",
];

export async function listImpersonationTargets(
  ctx: AuthContext,
  organizationId: string,
): Promise<ImpersonationTarget[]> {
  requireSuperadmin(ctx);
  requirePermission(ctx, "platform.org.read");

  const users = await prisma.user.findMany({
    where: { organizationId, status: "ACTIVE", role: { not: "SUPERADMIN" } },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  });

  // The employee code is on the other side of a one-to-one, and selecting it
  // through the relation is not offered on this delegate — so it is fetched
  // beside, by user id.
  const codes = new Map(
    (
      await prisma.employee.findMany({
        where: { organizationId, userId: { in: users.map((u) => u.id) } },
        select: { userId: true, employeeCode: true },
      })
    ).map((e) => [e.userId, e.employeeCode]),
  );

  return users
    .map((u) => ({
      userId: u.id,
      name: u.name,
      email: u.email,
      role: u.role as string,
      employeeCode: codes.get(u.id) ?? null,
    }))
    .sort((a, b) => {
      const byRole = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
      if (byRole !== 0) return byRole;
      return a.name.localeCompare(b.name, "en-IN");
    });
}
