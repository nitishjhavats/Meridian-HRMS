/**
 * Demo data.
 *
 * Everything here goes through the same code paths the product uses: payroll is
 * produced by the real engine rather than typed in, attendance respects the
 * organisation's week-off pattern, and salary structures are resolved by the
 * real component resolver. Seed data that disagrees with the app is worse than
 * no seed data at all.
 *
 *   npm run db:seed
 */

import { PrismaClient, type SystemRole } from "@prisma/client";
import { hashPassword, generateOtp, generateConfirmationCode } from "../src/lib/auth/password";
import { encryptField } from "../src/lib/crypto/field";
import { MODULES } from "../src/lib/features";
import { DEFAULT_ATTENDANCE_POLICY } from "../src/domain/attendance/policy";
import { evaluateDay } from "../src/domain/attendance/policy";
import { buildPeriodCalendar, type WeeklyOffConfig } from "../src/domain/calendar";
import { DEFAULT_PAYROLL_POLICY, resolveSalaryStructure } from "../src/domain/payroll/policy";
import { calculatePayroll } from "../src/domain/payroll/engine";
import {
  addDays,
  eachDay,
  endOfMonth,
  startOfMonth,
  zonedTimeToInstant,
  type DateOnly,
} from "../src/domain/date";
import { buildPayrollInput } from "../src/services/payroll/inputBuilder";
import { computeOrderAmount } from "../src/domain/billing/pricing";
import { storage } from "../src/lib/storage";
import { placeholderPdf } from "./seedPdf";

const prisma = new PrismaClient();

const TODAY = "2026-09-03";
const CURRENT_YEAR = 2026;
const PAYROLL_MONTH = 8; // August 2026 — the last completed month

/**
 * The payee on the seeded platform and its demo orders. Set PAYMENT_UPI_ID to
 * put a real one in; otherwise it is a handle no UPI app will pay, never a
 * person's own account.
 */
const SEED_PAYEE = process.env.PAYMENT_UPI_ID?.trim() || "payee@example";

const rupees = (n: number) => n * 100;

/**
 * Live demo rows are timed relative to the moment the seed runs, not to a fixed
 * date — otherwise the "awaiting review" payment is already expired by the time
 * anyone opens the console.
 */
const NOW = new Date();
const minutesFromNow = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const utc = (date: DateOnly) => new Date(`${date}T00:00:00.000Z`);

/**
 * Attendance timestamps are wall-clock times in the organisation's zone. A 9 am
 * check-in must become 03:30 UTC, not 09:00 UTC, or every seeded punch shows up
 * in the afternoon.
 */
const ORG_TIMEZONE = "Asia/Kolkata";
const at = (date: DateOnly, minutes: number) =>
  zonedTimeToInstant(date, minutes, ORG_TIMEZONE).getTime();

/** Deterministic PRNG so every seed run produces the same demo data. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xffffffff;
  };
}
const random = makeRandom(20260903);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;

/**
 * The schema this database URL actually points at.
 *
 * It used to be the literal `'public'`. On a laptop with a database of its own
 * that is the same thing; on a shared Postgres it is not, and truncating
 * everything in `public` would take somebody else's tables with it.
 */
function targetSchema(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  try {
    return new URL(url).searchParams.get("schema") ?? "public";
  } catch {
    return "public";
  }
}

/**
 * Empties the schema before seeding.
 *
 * This destroys data, and the seed is the only thing in the repository that
 * does. It refuses to run without `ALLOW_DESTRUCTIVE_SEED=1` so that a stray
 * `npm run db:seed` against a production `DATABASE_URL` — the kind of mistake
 * that happens once and is never recovered from — stops here instead.
 */
async function reset() {
  const schema = targetSchema();

  if (process.env.ALLOW_DESTRUCTIVE_SEED !== "1") {
    throw new Error(
      `Refusing to seed: this truncates every table in schema "${schema}" of the database ` +
        "DATABASE_URL points at. Re-run with ALLOW_DESTRUCTIVE_SEED=1 if that is what you want.",
    );
  }

  console.log(`  clearing existing data in "${schema}"…`);
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = ${schema} AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${schema}"."${t.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

// ------------------------------------------------------------------ platform

/**
 * The superadmin's password comes from SUPERADMIN_PASSWORD and nowhere else.
 * There used to be a fallback, published in the README; a database seeded
 * without setting one got a superadmin anybody could sign in as.
 */
function superadminPassword(): string {
  const password = process.env.SUPERADMIN_PASSWORD?.trim();
  if (!password) {
    throw new Error(
      "Refusing to seed: set SUPERADMIN_PASSWORD to a strong password first. The seed no longer invents one.",
    );
  }
  return password;
}

async function seedPlatform() {
  console.log("  platform settings + superadmin…");

  await prisma.platformSetting.create({
    data: {
      id: "singleton",
      pricePerUserPaise: rupees(59),
      billingPeriod: "MONTHLY",
      paymentUpiId: SEED_PAYEE,
      paymentPayeeName: "HRMS Platform",
      paymentWindowMinutes: 240,
      confirmationMode: "BOTH",
      otpTtlMinutes: 15,
      defaultTrialDays: 14,
      selfieRetentionDays: 60,
      defaultAiModel: "z-ai/glm-5.3-flash",
    },
  });

  const superadmin = await prisma.user.create({
    data: {
      email: process.env.SUPERADMIN_EMAIL ?? "superadmin@hrms.local",
      name: "Platform Owner",
      passwordHash: await hashPassword(superadminPassword()),
      role: "SUPERADMIN",
      status: "ACTIVE",
      passwordChangedAt: new Date(),
    },
  });

  return superadmin;
}

// ------------------------------------------------------------------ organisation

interface OrgSpec {
  name: string;
  slug: string;
  legalName: string;
  city: string;
  state: string;
  industry: string;
  seats: number;
  billingMode: "TRIAL" | "PAID" | "FREE_INTERNAL";
  latitude: number;
  longitude: number;
  weeklyOff: { name: string; type: "FIXED" | "ROTATIONAL"; config: WeeklyOffConfig };
  people: PersonSpec[];
}

interface PersonSpec {
  first: string;
  last: string;
  role: SystemRole;
  designation: string;
  department: string;
  ctc: number;
  code: string;
  training?: { days: number; percent: number };
  reportsTo?: string[];
}

const ORGS: OrgSpec[] = [
  {
    name: "Acme Technologies",
    slug: "acme",
    legalName: "Acme Technologies Private Limited",
    city: "Patna",
    state: "Bihar",
    industry: "Information Technology",
    seats: 25,
    billingMode: "PAID",
    latitude: 25.6093,
    longitude: 85.1235,
    weeklyOff: {
      name: "Sunday + alternate Saturday",
      type: "ROTATIONAL",
      config: { type: "ROTATIONAL", days: [0], rotating: [{ day: 6, weeks: [2, 4] }] },
    },
    people: [
      { first: "Rajesh", last: "Verma", role: "ORG_OWNER", designation: "CEO", department: "Leadership", ctc: 250_000, code: "ACM001" },
      { first: "Priya", last: "Sharma", role: "ADMIN", designation: "Director", department: "Leadership", ctc: 180_000, code: "ACM002", reportsTo: ["ACM001"] },
      { first: "Anita", last: "Desai", role: "HR_MANAGER", designation: "HR Manager", department: "Human Resources", ctc: 85_000, code: "ACM003", reportsTo: ["ACM002"] },
      // A MANAGER as well as a TEAM_LEAD, so `verify-sweep` has one of each to sign in as.
      { first: "Vikram", last: "Singh", role: "MANAGER", designation: "Engineering Manager", department: "Engineering", ctc: 140_000, code: "ACM004", reportsTo: ["ACM002"] },
      { first: "Neha", last: "Gupta", role: "TEAM_LEAD", designation: "Project Manager", department: "Engineering", ctc: 120_000, code: "ACM005", reportsTo: ["ACM002"] },
      { first: "Arjun", last: "Nair", role: "TEAM_MEMBER", designation: "Senior Developer", department: "Engineering", ctc: 95_000, code: "ACM006", reportsTo: ["ACM004", "ACM005"] },
      { first: "Sneha", last: "Patil", role: "TEAM_MEMBER", designation: "Developer", department: "Engineering", ctc: 65_000, code: "ACM007", reportsTo: ["ACM004"] },
      { first: "Rahul", last: "Mehta", role: "TEAM_MEMBER", designation: "Developer", department: "Engineering", ctc: 60_000, code: "ACM008", reportsTo: ["ACM004"] },
      { first: "Kavya", last: "Iyer", role: "TEAM_MEMBER", designation: "QA Engineer", department: "Engineering", ctc: 55_000, code: "ACM009", reportsTo: ["ACM005"] },
      { first: "Imran", last: "Khan", role: "TEAM_MEMBER", designation: "Accountant", department: "Finance", ctc: 48_000, code: "ACM010", reportsTo: ["ACM002"] },
      { first: "Deepa", last: "Rao", role: "TEAM_MEMBER", designation: "Intern", department: "Engineering", ctc: 30_000, code: "ACM011", reportsTo: ["ACM004"], training: { days: 90, percent: 70 } },
    ],
  },
  {
    name: "Bright Retail",
    slug: "bright-retail",
    legalName: "Bright Retail Ventures LLP",
    city: "Pune",
    state: "Maharashtra",
    industry: "Retail",
    seats: 10,
    billingMode: "TRIAL",
    latitude: 18.5204,
    longitude: 73.8567,
    weeklyOff: { name: "Sunday off", type: "FIXED", config: { type: "FIXED", days: [0] } },
    people: [
      { first: "Sunita", last: "Joshi", role: "ORG_OWNER", designation: "Founder", department: "Leadership", ctc: 150_000, code: "BR001" },
      { first: "Manish", last: "Kulkarni", role: "ADMIN", designation: "Store Head", department: "Operations", ctc: 90_000, code: "BR002", reportsTo: ["BR001"] },
      { first: "Pooja", last: "Shetty", role: "HR_MANAGER", designation: "HR Executive", department: "Human Resources", ctc: 52_000, code: "BR003", reportsTo: ["BR002"] },
      { first: "Amit", last: "Deshmukh", role: "TEAM_LEAD", designation: "Sales Manager", department: "Sales", ctc: 70_000, code: "BR004", reportsTo: ["BR002"] },
      { first: "Ritika", last: "Bose", role: "TEAM_MEMBER", designation: "Sales Executive", department: "Sales", ctc: 32_000, code: "BR005", reportsTo: ["BR004"] },
      { first: "Sameer", last: "Pawar", role: "TEAM_MEMBER", designation: "Sales Executive", department: "Sales", ctc: 30_000, code: "BR006", reportsTo: ["BR004"] },
      { first: "Farhan", last: "Ali", role: "TEAM_MEMBER", designation: "Store Associate", department: "Operations", ctc: 24_000, code: "BR007", reportsTo: ["BR002"], training: { days: 60, percent: 50 } },
    ],
  },
];

const HOLIDAYS_2026 = [
  { name: "Republic Day", date: "2026-01-26" },
  { name: "Holi", date: "2026-03-04" },
  { name: "Independence Day", date: "2026-08-15" },
  { name: "Gandhi Jayanti", date: "2026-10-02" },
  { name: "Diwali", date: "2026-11-08" },
];

const LEAVE_TYPES = [
  { code: "CL", name: "Casual Leave", annual: 12, paid: true, accrual: "MONTHLY", monthly: 1, color: "#3b82f6" },
  { code: "SL", name: "Sick Leave", annual: 8, paid: true, accrual: "ANNUAL", monthly: 0, color: "#ef4444" },
  { code: "EL", name: "Earned Leave", annual: 15, paid: true, accrual: "MONTHLY", monthly: 1.25, color: "#10b981", carry: true },
  { code: "LWP", name: "Leave Without Pay", annual: 0, paid: false, accrual: "NONE", monthly: 0, color: "#6b7280" },
  { code: "COMP_OFF", name: "Compensatory Off", annual: 0, paid: true, accrual: "NONE", monthly: 0, color: "#8b5cf6", comp: true },
];

async function seedOrganization(spec: OrgSpec, superadminId: string) {
  console.log(`\n  ${spec.name}…`);

  const org = await prisma.organization.create({
    data: {
      name: spec.name,
      legalName: spec.legalName,
      slug: spec.slug,
      email: `hr@${spec.slug}.com`,
      phone: "+91 98765 43210",
      website: `https://${spec.slug}.com`,
      industry: spec.industry,
      addressLine1: "2nd Floor, Tech Park",
      city: spec.city,
      state: spec.state,
      country: "India",
      postalCode: "800001",
      timezone: "Asia/Kolkata",
      currency: "INR",
      status: "ACTIVE",
      seatLimit: spec.seats,
      createdById: superadminId,
    },
  });

  const periodStart = new Date(`${CURRENT_YEAR}-01-01T00:00:00Z`);
  const periodEnd = new Date(`${CURRENT_YEAR + 1}-01-01T00:00:00Z`);

  await prisma.subscription.create({
    data: {
      organizationId: org.id,
      seats: spec.seats,
      status: spec.billingMode === "PAID" ? "ACTIVE" : "TRIAL",
      billingMode: spec.billingMode,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      trialEndsAt: spec.billingMode === "TRIAL" ? new Date("2026-09-20T00:00:00Z") : null,
      nextBillingDate: new Date("2026-10-01T00:00:00Z"),
      pricePerUserPaise: rupees(59),
    },
  });

  // Feature grants (superadmin) and module toggles (org admin).
  await prisma.featureGrant.createMany({
    data: MODULES.map((m) => ({
      organizationId: org.id,
      featureKey: m.key,
      granted: m.defaultGranted,
      grantedById: superadminId,
    })),
  });
  await prisma.orgModuleSetting.createMany({
    data: MODULES.map((m) => ({
      organizationId: org.id,
      moduleKey: m.key,
      // Acme runs everything; Bright Retail keeps the optional modules off.
      enabled: spec.slug === "acme" ? true : m.defaultEnabled,
    })),
  });

  // ---- structure
  const departmentNames = [...new Set(spec.people.map((p) => p.department))];
  const departments = new Map<string, string>();
  for (const name of departmentNames) {
    const row = await prisma.department.create({ data: { organizationId: org.id, name } });
    departments.set(name, row.id);
  }

  const designationTitles = [...new Set(spec.people.map((p) => p.designation))];
  const designations = new Map<string, string>();
  for (const [index, title] of designationTitles.entries()) {
    const row = await prisma.designation.create({
      data: { organizationId: org.id, title, level: index },
    });
    designations.set(title, row.id);
  }

  const workLocation = await prisma.workLocation.create({
    data: {
      organizationId: org.id,
      name: `${spec.city} Office`,
      address: `Tech Park, ${spec.city}`,
      latitude: spec.latitude,
      longitude: spec.longitude,
      radiusMeters: 150,
      requireSelfie: true,
      requireGps: true,
    },
  });

  const shift = await prisma.shift.create({
    data: {
      organizationId: org.id,
      name: "General Shift",
      startTime: "09:00",
      endTime: "18:00",
      breakMinutes: 60,
      graceMinutes: 10,
      isDefault: true,
    },
  });

  const weeklyOff = await prisma.weeklyOffPattern.create({
    data: {
      organizationId: org.id,
      name: spec.weeklyOff.name,
      type: spec.weeklyOff.type,
      config: spec.weeklyOff.config as object,
      isDefault: true,
    },
  });

  await prisma.holiday.createMany({
    data: HOLIDAYS_2026.map((h) => ({
      organizationId: org.id,
      name: h.name,
      date: utc(h.date as DateOnly),
      type: "PUBLIC" as const,
      paid: true,
    })),
  });

  const leaveTypes = new Map<string, string>();
  for (const lt of LEAVE_TYPES) {
    const row = await prisma.leaveType.create({
      data: {
        organizationId: org.id,
        code: lt.code,
        name: lt.name,
        paid: lt.paid,
        annualAllocation: lt.annual,
        accrualMode: lt.accrual,
        monthlyAccrual: lt.monthly,
        carryForward: lt.carry ?? false,
        maxCarryForward: lt.carry ? 10 : 0,
        isCompOff: lt.comp ?? false,
        color: lt.color,
      },
    });
    leaveTypes.set(lt.code, row.id);
  }

  // ---- salary components: Acme uses a real split, Bright Retail the default.
  const components =
    spec.slug === "acme"
      ? [
          { code: "BASIC", name: "Basic Salary", percent: 50, order: 1 },
          { code: "HRA", name: "House Rent Allowance", percent: 20, order: 2 },
          { code: "ALLOWANCE", name: "Special Allowance", percent: 20, order: 3 },
          { code: "OTHER", name: "Other Allowance", percent: 10, order: 4 },
        ]
      : DEFAULT_PAYROLL_POLICY.components.map((c) => ({
          code: c.code,
          name: c.name,
          percent: c.calc.type === "PERCENT_OF_CTC" ? c.calc.percent : 0,
          order: c.sortOrder,
        }));

  await prisma.salaryComponent.createMany({
    data: components.map((c) => ({
      organizationId: org.id,
      code: c.code,
      name: c.name,
      kind: "EARNING" as const,
      calc: { type: "PERCENT_OF_CTC", percent: c.percent },
      prorated: true,
      taxable: true,
      showOnSlip: true,
      sortOrder: c.order,
    })),
  });

  // ---- policy versions (what payroll and attendance actually read)
  const payrollPolicy = {
    ...DEFAULT_PAYROLL_POLICY,
    components: components.map((c) => ({
      code: c.code,
      name: c.name,
      kind: "EARNING" as const,
      calc: { type: "PERCENT_OF_CTC" as const, percent: c.percent },
      prorated: true,
      taxable: true,
      showOnSlip: true,
      sortOrder: c.order,
    })),
    ...(spec.slug === "acme"
      ? {
          attendance: {
            ...DEFAULT_PAYROLL_POLICY.attendance,
            late: { type: "HALF_DAY_PER_N" as const, n: 3, freeCount: 2 },
          },
          extraDay: { mode: "MULTIPLIER" as const, multiplier: 1 },
          overtime: { ...DEFAULT_PAYROLL_POLICY.overtime, enabled: true, rate: { type: "MULTIPLIER" as const, value: 1.5 } },
        }
      : {}),
  };

  await prisma.orgPolicyVersion.createMany({
    data: [
      {
        organizationId: org.id,
        kind: "PAYROLL",
        version: 1,
        payload: payrollPolicy as object,
        effectiveFrom: new Date(`${CURRENT_YEAR}-01-01T00:00:00Z`),
        active: true,
        approvedById: superadminId,
        approvedAt: new Date(),
      },
      {
        organizationId: org.id,
        kind: "ATTENDANCE",
        version: 1,
        payload: DEFAULT_ATTENDANCE_POLICY as unknown as object,
        effectiveFrom: new Date(`${CURRENT_YEAR}-01-01T00:00:00Z`),
        active: true,
      },
    ],
  });

  // ---- people
  const employees = new Map<string, { id: string; userId: string; ctc: number; spec: PersonSpec }>();

  for (const person of spec.people) {
    const email = `${person.first.toLowerCase()}.${person.last.toLowerCase()}@${spec.slug}.com`;
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email,
        name: `${person.first} ${person.last}`,
        passwordHash: await hashPassword("Password@123"),
        role: person.role,
        status: "ACTIVE",
        phone: `+91 9${Math.floor(random() * 900_000_000 + 100_000_000)}`,
        passwordChangedAt: new Date(),
      },
    });

    const joiningDate = person.training
      ? addDays(TODAY, -Math.floor(person.training.days / 2))
      : `202${Math.floor(random() * 4) + 1}-0${Math.floor(random() * 9) + 1}-1${Math.floor(random() * 8) + 1}`;

    const employee = await prisma.employee.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        employeeCode: person.code,
        firstName: person.first,
        lastName: person.last,
        gender: random() > 0.5 ? "MALE" : "FEMALE",
        dateOfBirth: utc(`199${Math.floor(random() * 9)}-0${Math.floor(random() * 9) + 1}-1${Math.floor(random() * 8) + 1}` as DateOnly),
        personalEmail: email,
        workEmail: email,
        phone: `+91 9${Math.floor(random() * 900_000_000 + 100_000_000)}`,
        addressLine1: "Flat 12B, Green Residency",
        city: spec.city,
        state: spec.state,
        country: "India",
        emergencyName: "Family Contact",
        emergencyPhone: "+91 98111 22233",
        joiningDate: utc(joiningDate as DateOnly),
        departmentId: departments.get(person.department)!,
        designationId: designations.get(person.designation)!,
        workLocationId: workLocation.id,
        shiftId: shift.id,
        weeklyOffPatternId: weeklyOff.id,
        employmentType: person.designation === "Intern" ? "INTERN" : "FULL_TIME",
        workMode: "ONSITE",
        employmentState: person.training ? "TRAINING" : "CONFIRMED",
        active: true,
        // Sensitive identifiers are encrypted, never stored in the clear.
        panCipher: encryptField(`ABCDE${Math.floor(random() * 9000 + 1000)}F`),
        aadhaarCipher: encryptField(String(Math.floor(random() * 900_000_000_000 + 100_000_000_000))),
        bankNameCipher: encryptField("State Bank of India"),
        bankAccountCipher: encryptField(String(Math.floor(random() * 90_000_000_000 + 10_000_000_000))),
        bankIfscCipher: encryptField("SBIN0001234"),
      },
    });

    // Salary profile with the resolved component breakdown frozen in.
    const structure = resolveSalaryStructure(
      rupees(person.ctc),
      payrollPolicy.components,
      payrollPolicy.percentBase,
    );
    await prisma.salaryProfile.create({
      data: {
        organizationId: org.id,
        employeeId: employee.id,
        ctcMonthlyPaise: rupees(person.ctc),
        effectiveFrom: utc(`${CURRENT_YEAR}-01-01` as DateOnly),
        structure: structure.earnings.map((e) => ({
          code: e.component.code,
          name: e.component.name,
          amountPaise: e.amountPaise,
          formula: e.formula,
        })) as object,
      },
    });

    if (person.training) {
      await prisma.trainingPlan.create({
        data: {
          organizationId: org.id,
          employeeId: employee.id,
          startDate: utc(joiningDate as DateOnly),
          endDate: utc(addDays(joiningDate as DateOnly, person.training.days) as DateOnly),
          mode: "PERCENT",
          percent: person.training.percent,
          postTrainingState: "REGULAR",
          postTrainingCtcPaise: rupees(person.ctc),
          note: `${person.training.days}-day training at ${person.training.percent}% of full salary`,
        },
      });
      await prisma.employmentStateChange.create({
        data: {
          employeeId: employee.id,
          toState: "TRAINING",
          effectiveOn: utc(joiningDate as DateOnly),
          reason: "Joined as a trainee",
        },
      });
    }

    // Leave balances for the year.
    for (const lt of LEAVE_TYPES) {
      if (lt.annual === 0) continue;
      await prisma.leaveBalance.create({
        data: {
          organizationId: org.id,
          employeeId: employee.id,
          leaveTypeId: leaveTypes.get(lt.code)!,
          year: CURRENT_YEAR,
          allocated: lt.annual,
          accrued: lt.accrual === "MONTHLY" ? Math.min(lt.annual, lt.monthly * 8) : lt.annual,
          used: Math.floor(random() * 4),
        },
      });
    }

    employees.set(person.code, { id: employee.id, userId: user.id, ctc: person.ctc, spec: person });
  }

  // ---- matrix reporting
  for (const person of spec.people) {
    for (const managerCode of person.reportsTo ?? []) {
      const employee = employees.get(person.code);
      const manager = employees.get(managerCode);
      if (!employee || !manager) continue;
      await prisma.reportingRelationship.create({
        data: {
          organizationId: org.id,
          employeeId: employee.id,
          managerId: manager.id,
          // Someone reporting to two managers gets one primary and one functional line.
          type: (person.reportsTo ?? [])[0] === managerCode ? "PRIMARY" : "FUNCTIONAL",
        },
      });
    }
  }

  // Designation-level reporting map, independent of individual people.
  const designationPairs: [string, string][] = spec.people
    .filter((p) => p.reportsTo?.length)
    .map((p) => [p.designation, spec.people.find((x) => x.code === p.reportsTo![0])!.designation]);
  const seenPairs = new Set<string>();
  for (const [from, to] of designationPairs) {
    const key = `${from}->${to}`;
    if (from === to || seenPairs.has(key)) continue;
    seenPairs.add(key);
    await prisma.designationReporting.create({
      data: {
        organizationId: org.id,
        designationId: designations.get(from)!,
        reportsToDesignationId: designations.get(to)!,
        type: "PRIMARY",
      },
    });
  }

  return { org, employees, leaveTypes, workLocation, shift, weeklyOff, payrollPolicy, departments };
}

// ------------------------------------------------------------------ attendance

async function seedAttendance(
  orgId: string,
  employees: Map<string, { id: string; spec: PersonSpec }>,
  weeklyOffConfig: WeeklyOffConfig,
  workLocationId: string,
) {
  console.log("    attendance for the last three months…");

  const from: DateOnly = "2026-06-01";
  const to: DateOnly = TODAY;

  const holidays = await prisma.holiday.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true, date: true, paid: true, optional: true },
  });

  for (const [, employee] of employees) {
    const calendar = buildPeriodCalendar(
      from,
      to,
      { employeeId: employee.id, weeklyOff: weeklyOffConfig },
      holidays.map((h) => ({
        id: h.id,
        name: h.name,
        date: h.date.toISOString().slice(0, 10) as DateOnly,
        paid: h.paid,
        optional: h.optional,
      })),
    );

    const days: {
      date: DateOnly;
      status: string;
      checkIn: number | null;
      checkOut: number | null;
      late: number;
      early: number;
      overtime: number;
    }[] = [];

    for (const day of calendar.days) {
      const roll = random();

      if (day.kind === "WEEK_OFF") {
        // Occasionally someone works a rest day — that becomes an extra day.
        if (roll > 0.94) {
          const evaluation = evaluateDay(
            { dayKind: "WEEK_OFF", checkInMinutes: 600, checkOutMinutes: 1_050 },
            DEFAULT_ATTENDANCE_POLICY,
          );
          days.push({ date: day.date, status: evaluation.status, checkIn: 600, checkOut: 1_050, late: 0, early: 0, overtime: evaluation.overtimeMinutes });
        } else {
          days.push({ date: day.date, status: "WEEK_OFF", checkIn: null, checkOut: null, late: 0, early: 0, overtime: 0 });
        }
        continue;
      }

      if (day.kind === "HOLIDAY") {
        days.push({ date: day.date, status: "HOLIDAY", checkIn: null, checkOut: null, late: 0, early: 0, overtime: 0 });
        continue;
      }

      // Working day.
      if (roll > 0.97) {
        days.push({ date: day.date, status: "ABSENT", checkIn: null, checkOut: null, late: 0, early: 0, overtime: 0 });
        continue;
      }
      if (roll > 0.94) {
        days.push({ date: day.date, status: "PAID_LEAVE", checkIn: null, checkOut: null, late: 0, early: 0, overtime: 0 });
        continue;
      }

      // Arrival between 08:50 and 09:40, departure between 17:40 and 19:30.
      const checkIn = 530 + Math.floor(random() * 50);
      const checkOut = 1_060 + Math.floor(random() * 110);
      const evaluation = evaluateDay(
        { dayKind: "WORKING", checkInMinutes: checkIn, checkOutMinutes: checkOut },
        DEFAULT_ATTENDANCE_POLICY,
      );

      days.push({
        date: day.date,
        status: employee.spec.training && evaluation.status === "FULL_DAY" ? "TRAINING_DAY" : evaluation.status,
        checkIn,
        checkOut,
        late: evaluation.lateMinutes,
        early: evaluation.earlyLeaveMinutes,
        overtime: evaluation.overtimeMinutes,
      });
    }

    await prisma.attendanceDay.createMany({
      data: days.map((d) => ({
        organizationId: orgId,
        employeeId: employee.id,
        date: utc(d.date),
        status: d.status as never,
        systemStatus: d.status as never,
        firstCheckInAt: d.checkIn != null ? new Date(at(d.date, d.checkIn)) : null,
        lastCheckOutAt: d.checkOut != null ? new Date(at(d.date, d.checkOut)) : null,
        workedMinutes: d.checkIn != null && d.checkOut != null ? d.checkOut - d.checkIn - 60 : 0,
        lateMinutes: d.late,
        earlyLeaveMinutes: d.early,
        overtimeMinutes: d.overtime,
        isExtraDay: d.status === "EXTRA_DAY",
        source: d.checkIn != null ? "SELF_GPS" : "SYSTEM",
      })),
    });

    // Check-in / check-out events for the most recent two weeks only — enough to
    // exercise the UI without seeding tens of thousands of rows.
    const recent = days.filter((d) => d.date >= addDays(TODAY, -14) && d.checkIn != null);
    if (recent.length > 0) {
      const dayRows = await prisma.attendanceDay.findMany({
        where: { employeeId: employee.id, date: { gte: utc(addDays(TODAY, -14)) } },
        select: { id: true, date: true },
      });
      const dayByDate = new Map(dayRows.map((r) => [r.date.toISOString().slice(0, 10), r.id]));

      await prisma.attendanceEvent.createMany({
        data: recent.flatMap((d) => {
          const dayId = dayByDate.get(d.date) ?? null;
          const base = {
            organizationId: orgId,
            employeeId: employee.id,
            attendanceDayId: dayId,
            latitude: 25.6093 + (random() - 0.5) * 0.0004,
            longitude: 85.1235 + (random() - 0.5) * 0.0004,
            accuracyMeters: 8 + Math.floor(random() * 20),
            distanceMeters: Math.floor(random() * 60),
            withinGeofence: true,
            workLocationId,
            source: "SELF_GPS" as const,
          };
          return [
            { ...base, type: "CHECK_IN" as const, occurredAt: new Date(at(d.date, d.checkIn!)) },
            { ...base, type: "CHECK_OUT" as const, occurredAt: new Date(at(d.date, d.checkOut!)) },
          ];
        }),
      });
    }
  }
}

// ------------------------------------------------------------------ payroll

async function seedPayroll(
  orgId: string,
  employees: Map<string, { id: string; ctc: number }>,
  policy: typeof DEFAULT_PAYROLL_POLICY,
  actorId: string,
) {
  console.log("    payroll run for August 2026 (locked, part-paid)…");

  // One employee carries an advance, so recovery is visible in the run.
  const first = [...employees.values()][0];
  if (first) {
    await prisma.salaryAdvance.create({
      data: {
        organizationId: orgId,
        employeeId: first.id,
        amountPaise: rupees(20_000),
        recoveredPaise: 0,
        issuedOn: utc("2026-08-05"),
        recovery: { mode: "INSTALLMENTS", installments: 4 },
        status: "ACTIVE",
        reason: "Medical emergency",
        approvedById: actorId,
      },
    });
  }

  const run = await prisma.payrollRun.create({
    data: {
      organizationId: orgId,
      periodYear: CURRENT_YEAR,
      periodMonth: PAYROLL_MONTH,
      periodStart: utc(startOfMonth(CURRENT_YEAR, PAYROLL_MONTH)),
      periodEnd: utc(endOfMonth(CURRENT_YEAR, PAYROLL_MONTH)),
      status: "LOCKED",
      revision: 1,
      policySnapshot: policy as object,
      calculatedAt: new Date("2026-09-01T05:00:00Z"),
      approvedAt: new Date("2026-09-01T06:00:00Z"),
      approvedById: actorId,
      lockedAt: new Date("2026-09-01T06:30:00Z"),
      lockedById: actorId,
      createdById: actorId,
    },
  });

  let totalNet = 0;
  let totalPaid = 0;

  for (const [employeeCode, employee] of employees) {
    const input = await buildPayrollInput(prisma, {
      employeeId: employee.id,
      organizationId: orgId,
      year: CURRENT_YEAR,
      month: PAYROLL_MONTH,
      policy,
    });
    if (!input) continue;

    const result = calculatePayroll(input, policy);
    totalNet += result.netPaise;

    // Most people are paid in full; a couple are left part-paid so the
    // disbursement UI has something real to show.
    const payFully = random() > 0.25;
    const paid = payFully ? result.netPaise : Math.round(result.netPaise * 0.6);
    totalPaid += paid;

    const item = await prisma.payrollItem.create({
      data: {
        organizationId: orgId,
        payrollRunId: run.id,
        employeeId: employee.id,
        ctcMonthlyPaise: result.ctcMonthlyPaise,
        basisDays: result.days.basisDays,
        payableDays: result.days.payableDays,
        presentDays: result.days.presentDays,
        paidLeaveDays: result.days.paidLeaveDays,
        unpaidLeaveDays: result.days.unpaidLeaveDays,
        halfDays: result.days.halfDays,
        absentDays: result.days.absentDays,
        weekOffDays: result.days.weekOffDays,
        holidayDays: result.days.holidayDays,
        extraDays: result.days.extraDays,
        lateCount: result.days.lateCount,
        overtimeMinutes: result.days.overtimeMinutes,
        grossPaise: result.grossPaise,
        earningsPaise: result.totalEarningsPaise,
        deductionsPaise: result.totalDeductionsPaise,
        advanceRecoveredPaise: result.advanceRecoveredPaise,
        netPaise: result.netPaise,
        paidPaise: paid,
        settlement: paid >= result.netPaise ? "PAID" : paid > 0 ? "PARTIALLY_PAID" : "UNPAID",
        earnings: result.earnings as object,
        deductions: result.deductions as object,
        trace: result.trace as object,
        warnings: result.warnings,
      },
    });

    if (paid > 0) {
      // A part payment is split into two entries, which is how it happens in real life.
      const entries = payFully ? [paid] : [Math.round(paid * 0.5), paid - Math.round(paid * 0.5)];
      await prisma.salaryPayment.createMany({
        data: entries.map((amount, index) => ({
          organizationId: orgId,
          payrollItemId: item.id,
          amountPaise: amount,
          paidOn: utc(index === 0 ? "2026-09-01" : "2026-09-02"),
          method: "BANK_TRANSFER",
          reference: `NEFT${Math.floor(random() * 900_000 + 100_000)}`,
          createdById: actorId,
        })),
      });
    }

    for (const recovery of result.advanceRecoveries) {
      await prisma.advanceRecoveryEntry.create({
        data: {
          advanceId: recovery.advanceId,
          payrollItemId: item.id,
          amountPaise: recovery.amountPaise,
          periodYear: CURRENT_YEAR,
          periodMonth: PAYROLL_MONTH,
        },
      });
      await prisma.salaryAdvance.update({
        where: { id: recovery.advanceId },
        data: { recoveredPaise: { increment: recovery.amountPaise } },
      });
    }

    await prisma.salarySlip.create({
      data: {
        organizationId: orgId,
        payrollItemId: item.id,
        // Same shape the service mints, so a demo slip number is one a person
        // could actually recognise — their employee code, not an id tail.
        slipNumber: `SLIP/${CURRENT_YEAR}${String(PAYROLL_MONTH).padStart(2, "0")}/${employeeCode}`,
        generatedById: actorId,
      },
    });
  }

  await prisma.payrollRun.update({
    where: { id: run.id },
    data: {
      totals: { netPaise: totalNet, paidPaise: totalPaid, outstandingPaise: totalNet - totalPaid },
    },
  });
}


// ------------------------------------------------------------------ content

async function seedContent(
  orgId: string,
  employees: Map<string, { id: string; userId: string; spec: PersonSpec }>,
  leaveTypes: Map<string, string>,
) {
  console.log("    documents, announcements, letters, leave requests…");

  const list = [...employees.values()];
  const admin = list.find((e) => e.spec.role === "ADMIN") ?? list[0]!;
  const hr = list.find((e) => e.spec.role === "HR_MANAGER") ?? admin;

  // Documents.
  for (const employee of list.slice(0, 6)) {
    for (const [category, title] of [
      ["IDENTITY", "Aadhaar Card"],
      ["IDENTITY", "PAN Card"],
      ["BANK", "Bank Statement"],
    ] as const) {
      const doc = await prisma.employeeDocument.create({
        data: {
          organizationId: orgId,
          employeeId: employee.id,
          category,
          title,
          status: random() > 0.3 ? "VERIFIED" : "PENDING_VERIFICATION",
          uploadedById: employee.userId,
          verifiedById: random() > 0.3 ? hr.userId : null,
          verifiedAt: random() > 0.3 ? new Date("2026-07-15T10:00:00Z") : null,
        },
      });
      // Store real bytes, not just a key. A seeded vault whose every "Open"
      // link 404s makes a working feature look broken.
      const pdf = placeholderPdf(`${title} — ${employee.spec.first} ${employee.spec.last}`);
      const key = `org/${orgId}/documents/seed-${doc.id}.pdf`;
      await storage().put(key, pdf, "application/pdf", { organizationId: orgId, kind: "documents" });

      await prisma.documentVersion.create({
        data: {
          documentId: doc.id,
          version: 1,
          fileKey: key,
          fileName: `${title.replaceAll(" ", "-").toLowerCase()}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          uploadedById: employee.userId,
        },
      });
    }
  }

  // A pending deletion request, so the approval queue is not empty.
  const someDoc = await prisma.employeeDocument.findFirst({ where: { organizationId: orgId } });
  if (someDoc) {
    await prisma.documentDeletionRequest.create({
      data: {
        organizationId: orgId,
        documentId: someDoc.id,
        requestedById: list[list.length - 1]!.userId,
        reason: "Uploaded the wrong file by mistake",
        status: "PENDING",
      },
    });
  }

  // Announcements with engagement.
  const announcement = await prisma.announcement.create({
    data: {
      organizationId: orgId,
      authorId: hr.userId,
      title: "Independence Day holiday — 15 August",
      body: "The office will remain closed on Saturday, 15 August. Attendance is not required and the day is fully paid.",
      audience: { scope: "ALL" },
      pinned: true,
      publishAt: new Date("2026-08-10T04:30:00Z"),
    },
  });
  await prisma.announcement.create({
    data: {
      organizationId: orgId,
      authorId: admin.userId,
      title: "August payroll has been processed",
      body: "Salary slips for August are available under Salary. Please raise any discrepancy with HR within seven days.",
      audience: { scope: "ALL" },
      publishAt: new Date("2026-09-01T07:00:00Z"),
    },
  });

  for (const employee of list.slice(0, 5)) {
    await prisma.announcementLike.create({
      data: { announcementId: announcement.id, userId: employee.userId },
    });
  }
  const comment = await prisma.announcementComment.create({
    data: {
      announcementId: announcement.id,
      userId: list[list.length - 1]!.userId,
      body: "Thanks for the heads-up!",
    },
  });
  await prisma.announcementComment.create({
    data: {
      announcementId: announcement.id,
      userId: hr.userId,
      parentId: comment.id,
      body: "Happy to help.",
    },
  });

  // Letter template and one issued letter.
  const template = await prisma.letterTemplate.create({
    data: {
      organizationId: orgId,
      title: "Offer Letter",
      category: "OFFER",
      bodyTemplate: [
        "Dear {{employee.name}},",
        "",
        "We are pleased to offer you the position of {{employee.designation}} at {{organization.name}}.",
        "Your date of joining will be {{employee.joiningDate}} and your monthly salary will be {{salary.monthlyCtc}}.",
        "",
        "You will report to {{employee.manager}}.",
        "",
        "We look forward to welcoming you.",
      ].join("\n"),
      signatoryName: "Anita Desai",
      signatoryTitle: "HR Manager",
      // Keys from the catalogue in `src/domain/letters/template.ts`. This
      // template used to use `{{employee_name}}`, `{{designation}}` and friends,
      // none of which exist there — so every token rendered as UNKNOWN and a
      // letter drafted from it could never be issued at all.
      placeholders: [
        "employee.name",
        "employee.designation",
        "employee.joiningDate",
        "salary.monthlyCtc",
        "employee.manager",
        "organization.name",
      ],
      createdById: hr.userId,
    },
  });

  const recipient = list[list.length - 1]!;
  await prisma.letter.create({
    data: {
      organizationId: orgId,
      employeeId: recipient.id,
      templateId: template.id,
      letterNumber: `LTR/${CURRENT_YEAR}/0001`,
      category: "OFFER",
      subject: "Offer of Employment",
      body: `Dear ${recipient.spec.first} ${recipient.spec.last},\n\nWe are pleased to offer you the position of ${recipient.spec.designation}.`,
      status: "ISSUED",
      issuedOn: utc("2026-08-20"),
      issuedById: hr.userId,
      createdById: hr.userId,
    },
  });

  // Leave requests: one approved, one still pending in the approver's queue.
  const requester = list[list.length - 1]!;
  const approver = list.find((e) => e.spec.role === "TEAM_LEAD") ?? admin;

  const approved = await prisma.leaveRequest.create({
    data: {
      organizationId: orgId,
      employeeId: requester.id,
      leaveTypeId: leaveTypes.get("CL")!,
      startDate: utc("2026-08-12"),
      endDate: utc("2026-08-12"),
      totalDays: 1,
      reason: "Personal work",
      status: "APPROVED",
    },
  });
  await prisma.leaveApproval.create({
    data: {
      leaveRequestId: approved.id,
      approverId: approver.userId,
      step: 1,
      status: "APPROVED",
      actedAt: new Date("2026-08-10T09:00:00Z"),
    },
  });

  const pending = await prisma.leaveRequest.create({
    data: {
      organizationId: orgId,
      employeeId: requester.id,
      leaveTypeId: leaveTypes.get("SL")!,
      startDate: utc("2026-09-10"),
      endDate: utc("2026-09-11"),
      totalDays: 2,
      reason: "Fever, advised rest",
      status: "PENDING",
    },
  });
  await prisma.leaveApproval.create({
    data: { leaveRequestId: pending.id, approverId: approver.userId, step: 1, status: "PENDING" },
  });
}

// ------------------------------------------------------------------ billing

async function seedBilling(orgs: { id: string; name: string; seats: number }[], superadminId: string) {
  console.log("\n  coupons, payment orders, reset request…");

  const coupons = await Promise.all([
    prisma.coupon.create({
      data: {
        code: "LAUNCH10",
        description: "10% off for early customers",
        percent: 10,
        startsAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2026-12-31T23:59:59Z"),
        maxRedemptions: 100,
        redemptionCount: 1,
        active: true,
        createdById: superadminId,
      },
    }),
    prisma.coupon.create({
      data: {
        code: "SCALE25",
        description: "25% off for 50 seats or more",
        percent: 25,
        maxDiscountPaise: rupees(2_000),
        startsAt: new Date("2026-06-01T00:00:00Z"),
        expiresAt: new Date("2026-10-31T23:59:59Z"),
        minUserCount: 50,
        active: true,
        createdById: superadminId,
      },
    }),
    prisma.coupon.create({
      data: {
        code: "EXPIRED5",
        description: "Old campaign, kept for the audit trail",
        percent: 5,
        startsAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2026-03-31T23:59:59Z"),
        active: false,
        createdById: superadminId,
      },
    }),
  ]);

  const pricePerUser = rupees(59);
  let orderSeq = 1;

  // An approved order for the paying organisation.
  const acme = orgs[0]!;
  const approvedQuote = computeOrderAmount({
    userCount: acme.seats,
    pricePerUserPaise: pricePerUser,
    coupon: {
      code: "LAUNCH10",
      percent: 10,
      startsAt: new Date("2026-01-01"),
      expiresAt: new Date("2026-12-31"),
      redemptionCount: 0,
      active: true,
    },
  });

  const approvedOrder = await prisma.paymentOrder.create({
    data: {
      organizationId: acme.id,
      orderNumber: `ORD-2026-${String(orderSeq++).padStart(4, "0")}`,
      userCount: acme.seats,
      pricePerUserPaise: pricePerUser,
      subtotalPaise: approvedQuote.subtotalPaise,
      discountPaise: approvedQuote.discountPaise,
      payablePaise: approvedQuote.payablePaise,
      couponId: coupons[0]!.id,
      couponCode: "LAUNCH10",
      status: "APPROVED",
      upiId: SEED_PAYEE,
      periodMonths: 12,
      confirmationCode: "UTR884512339",
      transactionRef: "UTR884512339",
      submittedAt: new Date("2026-01-02T10:05:00Z"),
      reviewedAt: new Date("2026-01-02T11:30:00Z"),
      reviewedById: superadminId,
      reviewNote: "Verified in the bank statement.",
      expiresAt: new Date("2026-01-02T14:00:00Z"),
      windowMinutes: 240,
      previousSeats: 0,
    },
  });

  await prisma.couponRedemption.create({
    data: {
      couponId: coupons[0]!.id,
      paymentOrderId: approvedOrder.id,
      organizationId: acme.id,
      discountPaise: approvedQuote.discountPaise,
    },
  });
  await prisma.subscriptionHistory.create({
    data: {
      organizationId: acme.id,
      paymentOrderId: approvedOrder.id,
      previousSeats: 0,
      newSeats: acme.seats,
      newPeriodEnd: new Date("2027-01-01T00:00:00Z"),
      amountPaise: approvedQuote.payablePaise,
      note: "Initial purchase",
      createdById: superadminId,
    },
  });
  await prisma.paymentOrderEvent.createMany({
    data: [
      { paymentOrderId: approvedOrder.id, toStatus: "INITIATED", createdAt: new Date("2026-01-02T10:00:00Z") },
      { paymentOrderId: approvedOrder.id, fromStatus: "INITIATED", toStatus: "AWAITING_CONFIRMATION", createdAt: new Date("2026-01-02T10:05:00Z") },
      { paymentOrderId: approvedOrder.id, fromStatus: "AWAITING_CONFIRMATION", toStatus: "APPROVED", actorId: superadminId, note: "Verified", createdAt: new Date("2026-01-02T11:30:00Z") },
    ],
  });

  // A live request sitting in the Superadmin queue right now.
  const bright = orgs[1]!;
  const pendingQuote = computeOrderAmount({ userCount: 15, pricePerUserPaise: pricePerUser });
  const pendingOrder = await prisma.paymentOrder.create({
    data: {
      organizationId: bright.id,
      orderNumber: `ORD-2026-${String(orderSeq++).padStart(4, "0")}`,
      userCount: 15,
      pricePerUserPaise: pricePerUser,
      subtotalPaise: pendingQuote.subtotalPaise,
      discountPaise: 0,
      payablePaise: pendingQuote.payablePaise,
      status: "AWAITING_CONFIRMATION",
      upiId: SEED_PAYEE,
      periodMonths: 12,
      confirmationCode: "UTR552091447",
      transactionRef: "UTR552091447",
      payerNote: "Paid via PhonePe a few minutes ago",
      submittedAt: minutesFromNow(-25),
      expiresAt: minutesFromNow(215),
      windowMinutes: 240,
      previousSeats: 10,
    },
  });
  await prisma.paymentOrderEvent.createMany({
    data: [
      { paymentOrderId: pendingOrder.id, toStatus: "INITIATED", createdAt: minutesFromNow(-40) },
      { paymentOrderId: pendingOrder.id, fromStatus: "INITIATED", toStatus: "AWAITING_CONFIRMATION", createdAt: minutesFromNow(-25) },
    ],
  });

  // An expired request, to prove the 4-hour window is enforced on read.
  const expiredQuote = computeOrderAmount({ userCount: 5, pricePerUserPaise: pricePerUser });
  await prisma.paymentOrder.create({
    data: {
      organizationId: bright.id,
      orderNumber: `ORD-2026-${String(orderSeq++).padStart(4, "0")}`,
      userCount: 5,
      pricePerUserPaise: pricePerUser,
      subtotalPaise: expiredQuote.subtotalPaise,
      discountPaise: 0,
      payablePaise: expiredQuote.payablePaise,
      status: "EXPIRED",
      upiId: SEED_PAYEE,
      periodMonths: 12,
      expiresAt: minutesFromNow(-60 * 24 * 6),
      windowMinutes: 240,
      previousSeats: 10,
    },
  });

  // An order awaiting a Superadmin-issued code (confirmation mode CODE).
  const code = await generateConfirmationCode();
  const codeQuote = computeOrderAmount({ userCount: 30, pricePerUserPaise: pricePerUser });
  await prisma.paymentOrder.create({
    data: {
      organizationId: acme.id,
      orderNumber: `ORD-2026-${String(orderSeq++).padStart(4, "0")}`,
      userCount: 30,
      pricePerUserPaise: pricePerUser,
      subtotalPaise: codeQuote.subtotalPaise,
      discountPaise: 0,
      payablePaise: codeQuote.payablePaise,
      status: "INITIATED",
      upiId: SEED_PAYEE,
      periodMonths: 12,
      issuedCodeHash: code.hash,
      issuedCodeCipher: encryptField(code.plaintext),
      codeIssuedAt: minutesFromNow(-10),
      codeIssuedById: superadminId,
      expiresAt: minutesFromNow(230),
      windowMinutes: 240,
      previousSeats: 25,
    },
  });

  console.log(`    open order confirmation code is ${code.plaintext} (Superadmin-issued, see the payments queue)`);

  // A password-reset request waiting for the Superadmin to release the OTP.
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true, email: true, organizationId: true } });
  if (admin) {
    const otp = await generateOtp();
    await prisma.passwordResetRequest.create({
      data: {
        userId: admin.id,
        organizationId: admin.organizationId,
        requestedEmail: admin.email,
        otpHash: otp.hash,
        // Encrypted, not plaintext — the Superadmin decrypts it only on release.
        otpCipher: encryptField(otp.plaintext),
        status: "PENDING",
        expiresAt: new Date(Date.now() + 15 * 60_000),
        ipAddress: "203.0.113.42",
      },
    });
    console.log(`    reset OTP for ${admin.email} is ${otp.plaintext} (visible only in the Superadmin console)`);
  }
}

// ------------------------------------------------------------------ main

async function main() {
  console.log("\nSeeding HRMS demo data\n");
  // Checked before the truncate, so a missing password costs nothing.
  superadminPassword();
  await reset();

  const superadmin = await seedPlatform();
  const created: { id: string; name: string; seats: number }[] = [];

  for (const spec of ORGS) {
    const { org, employees, leaveTypes, workLocation, payrollPolicy } = await seedOrganization(
      spec,
      superadmin.id,
    );

    await seedAttendance(org.id, employees, spec.weeklyOff.config, workLocation.id);

    const adminUser = [...employees.values()].find((e) => e.spec.role === "ADMIN");
    await seedPayroll(org.id, employees, payrollPolicy, adminUser?.userId ?? superadmin.id);
    await seedContent(org.id, employees, leaveTypes);

    created.push({ id: org.id, name: org.name, seats: spec.seats });
  }

  await seedBilling(created, superadmin.id);

  const counts = await Promise.all([
    prisma.organization.count(),
    prisma.user.count(),
    prisma.employee.count(),
    prisma.attendanceDay.count(),
    prisma.payrollItem.count(),
    prisma.paymentOrder.count(),
  ]);

  console.log("\n─────────────────────────────────────────────");
  console.log(`  organisations   ${counts[0]}`);
  console.log(`  users           ${counts[1]}`);
  console.log(`  employees       ${counts[2]}`);
  console.log(`  attendance days ${counts[3]}`);
  console.log(`  payroll items   ${counts[4]}`);
  console.log(`  payment orders  ${counts[5]}`);
  console.log("─────────────────────────────────────────────");
  console.log("\n  Sign in with:");
  // The demo logins below are printed because they are public knowledge and
  // useless outside a seeded database. The Superadmin password is not: when it
  // has been set deliberately, printing it would put a real credential into
  // whatever captured this output — a CI log, a deployment log, a scrollback.
  console.log(
    `    Superadmin   ${process.env.SUPERADMIN_EMAIL ?? "superadmin@hrms.local"} / ` +
      "(the SUPERADMIN_PASSWORD you set)",
  );
  console.log("    Owner        rajesh.verma@acme.com / Password@123");
  console.log("    Admin        priya.sharma@acme.com / Password@123");
  console.log("    HR Manager   anita.desai@acme.com / Password@123");
  console.log("    Manager      vikram.singh@acme.com / Password@123");
  console.log("    Team Lead    neha.gupta@acme.com / Password@123");
  console.log("    Team Member  sneha.patil@acme.com / Password@123");
  console.log("");
}

main()
  .catch((error) => {
    console.error("\nSeed failed:\n", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
