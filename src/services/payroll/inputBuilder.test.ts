import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { DayKind } from "@/domain/calendar";
import { DEFAULT_ATTENDANCE_POLICY, type AttendanceStatus } from "@/domain/attendance/policy";
import { DEFAULT_PAYROLL_POLICY } from "@/domain/payroll/policy";
import {
  buildPayrollInput,
  claimsRidingRun,
  statusForMissingAttendance,
  weekOffQuotaFor,
} from "./inputBuilder";

/**
 * Two payroll invariants that cost real money when they slip.
 *
 * Neither of these can be reached through the engine's own tests: one is a
 * database predicate and the other is a fallback that only fires when a row is
 * missing, which is exactly the case no fixture thinks to create. Both are pure
 * functions now, so both can be pinned without a database.
 */

// --------------------------------------------------- which claims ride a run

/**
 * The fields of a `ReimbursementClaim` the predicate is allowed to look at.
 * Anything else it names makes `matches` throw rather than quietly pass.
 */
interface ClaimRow {
  organizationId: string;
  status: "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "PAID";
  paidInRunId: string | null;
  periodYear: number | null;
  periodMonth: number | null;
}

/**
 * A deliberately small interpreter for the slice of Prisma's `where` grammar
 * this predicate uses.
 *
 * It throws on anything it does not model — an unknown field, an unknown
 * operator, a shape it cannot read. That is the point: a test that silently
 * ignored a new clause would keep passing while the predicate it claims to pin
 * had changed meaning underneath it.
 */
function matches(where: Prisma.ReimbursementClaimWhereInput, claim: ClaimRow): boolean {
  const row = claim as unknown as Record<string, unknown>;

  return Object.entries(where as Record<string, unknown>).every(([field, condition]) => {
    if (field === "AND") {
      return (condition as Prisma.ReimbursementClaimWhereInput[]).every((c) => matches(c, claim));
    }
    if (field === "OR") {
      // An empty OR matches nothing, the same as Prisma.
      return (condition as Prisma.ReimbursementClaimWhereInput[]).some((c) => matches(c, claim));
    }
    if (!(field in row)) {
      throw new Error(`predicate filters on "${field}", which this test does not model`);
    }
    const actual = row[field];

    if (condition === null || typeof condition === "string" || typeof condition === "number") {
      return actual === condition;
    }
    if (typeof condition === "object") {
      return Object.entries(condition as Record<string, unknown>).every(([operator, value]) => {
        switch (operator) {
          case "equals":
            return actual === value;
          case "lt":
            return typeof actual === "number" && actual < (value as number);
          case "lte":
            return typeof actual === "number" && actual <= (value as number);
          default:
            throw new Error(`predicate uses the "${operator}" operator, which this test cannot read`);
        }
      });
    }
    throw new Error(`predicate uses a condition shape on "${field}" that this test cannot read`);
  });
}

const ORG = "org_1";
const RUN_A = "run_a";
const RUN_B = "run_b";

/** March 2026: the period both runs below are paying. */
const MARCH = "2026-03-31";

function claim(over: Partial<ClaimRow> = {}): ClaimRow {
  return {
    organizationId: ORG,
    status: "APPROVED",
    paidInRunId: null,
    periodYear: 2026,
    periodMonth: 3,
    ...over,
  };
}

/** What run A's payslips show as reimbursed. */
const runA = claimsRidingRun({ organizationId: ORG, periodEnd: MARCH, payrollRunId: RUN_A });
/** A second run over the same period — a revision, or the next org-wide run. */
const runB = claimsRidingRun({ organizationId: ORG, periodEnd: MARCH, payrollRunId: RUN_B });

describe("claimsRidingRun", () => {
  it("includes an approved claim nobody has paid yet", () => {
    expect(matches(runA, claim())).toBe(true);
  });

  it("includes an approved claim left over from an earlier period", () => {
    // Approved after February's run was locked. If this were excluded it would
    // never be paid by anything: February is closed and March would not see it.
    expect(matches(runA, claim({ periodYear: 2026, periodMonth: 2 }))).toBe(true);
    expect(matches(runA, claim({ periodYear: 2025, periodMonth: 12 }))).toBe(true);
  });

  it("excludes a claim booked against a later period", () => {
    // April's claim is April's money. Paying it in March both overpays this run
    // and leaves April's payslip explaining a reimbursement that is not there.
    expect(matches(runA, claim({ periodYear: 2026, periodMonth: 4 }))).toBe(false);
    expect(matches(runA, claim({ periodYear: 2027, periodMonth: 1 }))).toBe(false);
  });

  it("does not let a claim paid by run A ride run B as well", () => {
    // The expensive direction. Before claims were stamped at all, the same
    // approved amount was added to every later run whose period matched, and
    // the employee was reimbursed once per run.
    const paidByA = claim({ status: "PAID", paidInRunId: RUN_A });
    expect(matches(runB, paidByA)).toBe(false);
  });

  it("still counts a claim paid by run A inside run A's own predicate", () => {
    // The other direction, and the reason the PAID arm exists at all: unlocking
    // run A and recalculating it must not drop a reimbursement that has already
    // been agreed and printed on a payslip.
    const paidByA = claim({ status: "PAID", paidInRunId: RUN_A });
    expect(matches(runA, paidByA)).toBe(true);
  });

  it("does not admit a claim on the run stamp alone, whatever its status", () => {
    // Found by mutation: dropping `status: "PAID"` from the PAID arm left every
    // one of these tests green, because nothing asserted the status half of it.
    // `runs.ts` is the only writer of `paidInRunId` and always writes PAID
    // beside it, so the arm reads as belt and braces — but it is the belt that
    // stops a rejected claim carrying an old stamp from being paid on a
    // recalculate, and a test that claims to pin both arms should pin both.
    expect(matches(runA, claim({ status: "REJECTED", paidInRunId: RUN_A }))).toBe(false);
    expect(matches(runA, claim({ status: "DRAFT", paidInRunId: RUN_A }))).toBe(false);
  });

  it("leaves a claim with no period out of every run", () => {
    // `periodYear` and `periodMonth` are nullable. Neither arm can match a null,
    // so an unfiled claim waits rather than being swept into whichever run is
    // calculated next — which is the safe direction, and worth saying out loud
    // because the alternative is somebody paid from a month they never chose.
    expect(matches(runA, claim({ periodYear: null, periodMonth: null }))).toBe(false);
  });

  it("ignores claims paid by a run when there is no run — a simulation", () => {
    // A what-if calculation has no run of its own, so there is nothing whose
    // existing payments need preserving; only unpaid approvals apply.
    const preview = claimsRidingRun({ organizationId: ORG, periodEnd: MARCH });
    expect(matches(preview, claim())).toBe(true);
    expect(matches(preview, claim({ status: "PAID", paidInRunId: RUN_A }))).toBe(false);
  });

  it("excludes claims that are not approved, and claims approved but stamped elsewhere", () => {
    expect(matches(runA, claim({ status: "SUBMITTED" }))).toBe(false);
    expect(matches(runA, claim({ status: "REJECTED" }))).toBe(false);
    // Approved yet already stamped against another run: paid, whatever the
    // status column says, and not this run's to pay again.
    expect(matches(runA, claim({ status: "APPROVED", paidInRunId: RUN_B }))).toBe(false);
  });

  it("is scoped to one organisation", () => {
    expect(matches(runA, claim({ organizationId: "org_2" }))).toBe(false);
  });

  /**
   * `markReimbursementsPaid` intersects the predicate with "not yet stamped"
   * before it writes. That narrowing is what makes locking a recalculated run
   * idempotent, and it is easy to lose in a refactor because dropping it still
   * pays the right people — it just moves `paidAt` and reports money as newly
   * paid every time the run is relocked.
   */
  it("narrows to nothing left to stamp once run A has paid its claims", () => {
    const toStamp = (row: ClaimRow) =>
      matches(runA, row) && row.status === "APPROVED" && row.paidInRunId === null;

    expect(toStamp(claim())).toBe(true);
    expect(toStamp(claim({ status: "PAID", paidInRunId: RUN_A }))).toBe(false);
  });
});

// ------------------------------------------ a missing attendance row is not pay

/**
 * Every day kind, kept exhaustive by the type. If `DayKind` grows a member this
 * object stops compiling, and whoever added it has to say what an unmarked day
 * of that kind is worth before payroll decides for them.
 */
const EVERY_DAY_KIND: Record<DayKind, true> = { WORKING: true, WEEK_OFF: true, HOLIDAY: true };

/**
 * Statuses the engine pays for as though the person was there: the first four
 * are counted into `presentDays` and `EXTRA_DAY` is credited on top of the
 * month, while `PAID_LEAVE` is paid without being worked. A missing attendance
 * row must never resolve to any of them.
 */
const PAID_AS_ATTENDED = [
  "FULL_DAY",
  "HALF_DAY",
  "ON_DUTY",
  "TRAINING_DAY",
  "EXTRA_DAY",
  "PAID_LEAVE",
];

describe("statusForMissingAttendance", () => {
  it("treats an unmarked working day as an absence", () => {
    expect(statusForMissingAttendance("WORKING")).toBe("ABSENT");
  });

  it("leaves an unmarked rest day a rest day", () => {
    expect(statusForMissingAttendance("WEEK_OFF")).toBe("WEEK_OFF");
  });

  it("leaves an unmarked holiday a holiday", () => {
    expect(statusForMissingAttendance("HOLIDAY")).toBe("HOLIDAY");
  });

  /**
   * The invariant, and the reason this function was worth extracting. An
   * organisation whose device sync or attendance job stops writing rows keeps
   * running payroll with an empty attendance table. If the fallback ever paid
   * the day, every one of those employees would be paid in full for a month
   * nobody attended, and nothing in the run would report an error.
   */
  it("never resolves a missing row into a paid day, for any day kind", () => {
    for (const kind of Object.keys(EVERY_DAY_KIND) as DayKind[]) {
      expect(PAID_AS_ATTENDED).not.toContain(statusForMissingAttendance(kind));
    }
  });
});

describe("a person's own week-off quota beats the designation's", () => {
  /**
   * The engine has read `weekOffQuota` for a while; what is new is where it
   * comes from. Reverting `weekOffQuotaFor` to the designation-only reading
   * would leave every other test green and the figure on the profile card
   * ignored by the payslip.
   */
  it("person, then designation, then nothing", () => {
    expect(weekOffQuotaFor({ weekOffsPerMonth: 3, designation: { weekOffsPerMonth: 4 } })).toBe(3);
    expect(weekOffQuotaFor({ weekOffsPerMonth: null, designation: { weekOffsPerMonth: 4 } })).toBe(4);
    expect(weekOffQuotaFor({ weekOffsPerMonth: null, designation: { weekOffsPerMonth: null } })).toBeNull();
    expect(weekOffQuotaFor({ weekOffsPerMonth: null, designation: null })).toBeNull();
  });

  it("and a personal zero is a real quota, not an absence", () => {
    expect(weekOffQuotaFor({ weekOffsPerMonth: 0, designation: { weekOffsPerMonth: 4 } })).toBe(0);
  });
});

// ------------------------------------------ an open day never reaches the ledger

/**
 * `CHECKED_IN` is the state of a day between the check-in and the check-out.
 * It is meant to be replaced -- by a check-out, or by the close of the day
 * through `missingCheckout` -- and a row that is still `CHECKED_IN` when payroll
 * runs is one the close never reached. The engine has no case for it: carried
 * into the ledger it counts as nothing, neither worked nor absent. So the
 * builder settles it the way the close would, with the organisation's rule.
 *
 * The builder needs a database, so it is given the smallest one that answers
 * its queries: one employee on the rolls all month, no salary, no holidays, no
 * leave, no advances, and whatever attendance rows the test hands it.
 */

const EMPLOYEE = "emp_1";

interface AttendanceRow {
  date: string;
  status: AttendanceStatus;
}

function fakeDb(rows: AttendanceRow[]): PrismaClient {
  const none = { findMany: async () => [] };
  const db = {
    employee: {
      findFirst: async () => ({
        id: EMPLOYEE,
        employeeCode: "E1",
        firstName: "Asha",
        lastName: null,
        joiningDate: new Date("2026-01-01T00:00:00Z"),
        exitDate: null,
        departmentId: null,
        employmentState: "CONFIRMED",
        weekOffsPerMonth: null,
        designation: null,
        weeklyOffConfig: null,
        weeklyOffPattern: null,
        trainingPlans: [],
      }),
    },
    salaryProfile: { findFirst: async () => null },
    holiday: none,
    attendanceDay: {
      findMany: async () =>
        rows.map((row) => ({
          date: new Date(`${row.date}T00:00:00Z`),
          status: row.status,
          lateMinutes: 0,
          earlyLeaveMinutes: 0,
          overtimeMinutes: 0,
        })),
    },
    salaryAdvance: none,
    reimbursementClaim: none,
    payrollAdjustment: none,
    leaveRequest: none,
    // No organisation default either, so the resolver lands on the shipped
    // Sunday. The dates below are weekdays, so the rest day never matters.
    weeklyOffPattern: { findFirst: async () => null },
  };
  return db as unknown as PrismaClient;
}

async function ledgerFor(
  rows: AttendanceRow[],
  missingCheckout?: "IGNORE" | "HALF_DAY" | "ABSENT",
) {
  const input = await buildPayrollInput(fakeDb(rows), {
    employeeId: EMPLOYEE,
    organizationId: ORG,
    year: 2026,
    month: 9,
    policy: DEFAULT_PAYROLL_POLICY,
    ...(missingCheckout ? { missingCheckout } : {}),
  });
  if (!input) throw new Error("the employee is on the rolls; the builder should not have skipped them");
  return input.ledger;
}

/** A Monday. */
const OPEN_DAY = "2026-09-14";
/** The Sunday before it: the shipped weekly off, which the fake database lands on. */
const REST_DAY = "2026-09-13";

describe("a CHECKED_IN row is settled through missingCheckout before it reaches the ledger", () => {
  it.each([
    ["ABSENT", "ABSENT"],
    ["HALF_DAY", "HALF_DAY"],
    ["IGNORE", "FULL_DAY"],
  ] as const)("with the rule %s the day is %s", async (rule, expected) => {
    const ledger = await ledgerFor([{ date: OPEN_DAY, status: "CHECKED_IN" }], rule);
    expect(ledger.find((d) => d.date === OPEN_DAY)?.status).toBe(expected);
  });

  it("falls back to the shipped rule when the caller passes none", async () => {
    // A simulation or a script that never reads the organisation's policy
    // still settles the day rather than leaking the status through.
    expect(DEFAULT_ATTENDANCE_POLICY.missingCheckout).toBe("HALF_DAY");
    const ledger = await ledgerFor([{ date: OPEN_DAY, status: "CHECKED_IN" }]);
    expect(ledger.find((d) => d.date === OPEN_DAY)?.status).toBe("HALF_DAY");
  });

  it.each(["ABSENT", "HALF_DAY", "IGNORE"] as const)(
    "a rest-day CHECKED_IN row settles to EXTRA_DAY under the rule %s",
    async (rule) => {
      // The missing-checkout rule is a working-day rule. A check-in on a
      // Sunday with no check-out is the extra day the close would make of it,
      // whatever the organisation chose for weekdays -- under ABSENT it was
      // settling a Sunday somebody worked to an absence.
      const ledger = await ledgerFor([{ date: REST_DAY, status: "CHECKED_IN" }], rule);
      expect(ledger.find((d) => d.date === REST_DAY)?.status).toBe("EXTRA_DAY");
    },
  );
});

describe("no ledger entry is ever CHECKED_IN", () => {
  /**
   * Every status, kept exhaustive by the type: if `AttendanceStatus` grows a
   * member this object stops compiling, and the new one is fed through here
   * before anybody decides what payroll makes of it.
   */
  const EVERY_STATUS: Record<AttendanceStatus, true> = {
    FULL_DAY: true,
    HALF_DAY: true,
    ABSENT: true,
    WEEK_OFF: true,
    DAY_OFF: true,
    HOLIDAY: true,
    EXTRA_DAY: true,
    PAID_LEAVE: true,
    UNPAID_LEAVE: true,
    TRAINING_DAY: true,
    ON_DUTY: true,
    NOT_MARKED: true,
    CHECKED_IN: true,
  };

  // One status per weekday of September 2026, starting on the first Monday.
  const rows: AttendanceRow[] = (Object.keys(EVERY_STATUS) as AttendanceStatus[]).map(
    (status, index) => {
      const day = 7 + index + Math.floor(index / 5) * 2; // skip each weekend
      return { date: `2026-09-${String(day).padStart(2, "0")}`, status };
    },
  );

  it.each(["ABSENT", "HALF_DAY", "IGNORE"] as const)("under the rule %s", async (rule) => {
    const ledger = await ledgerFor(rows, rule);
    expect(ledger.length).toBeGreaterThan(rows.length);
    expect(ledger.map((d) => d.status)).not.toContain("CHECKED_IN");
  });

  it("and every settled status passes through untouched", async () => {
    // Settling must not overreach: a day already scored keeps its score, or
    // the rule for a missing check-out would rewrite days that had one.
    const ledger = await ledgerFor(rows, "ABSENT");
    for (const row of rows) {
      if (row.status === "CHECKED_IN") continue;
      expect(ledger.find((d) => d.date === row.date)?.status).toBe(row.status);
    }
  });

  it("calculateRun hands the builder the organisation's own rule, not the shipped one", () => {
    // The wiring the fake database cannot reach. Without it every real run
    // would settle through the default, and an organisation on ABSENT would
    // pay a half day for a night the close missed.
    const code = readFileSync(path.resolve("src/services/payroll/runs.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).toMatch(/const \{ missingCheckout \} = await getAttendanceRules\(ctx, periodStart\)/);
    expect(code).toMatch(/buildPayrollInput\(prisma, \{[^}]*missingCheckout,/);
  });
});
