import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What "not accepted" is allowed to mean.
 *
 * There was no test file here at all, which is how the queue reached production
 * with three defects that only show up as money: rejecting changed nothing,
 * anybody holding `attendance.override` could see and decide every employee's
 * mark in the organisation, and the sweep that deletes selfies after sixty days
 * did not care whether somebody was still waiting to look at one.
 *
 * Source assertions again, and for the same reason as `marking.test.ts`: these
 * are guarantees about control flow through functions that need a database, and
 * this repository does not mock Prisma. Where a decision can be extracted and
 * tested directly it is; what is left is the ordering, and ordering is what
 * went wrong.
 */

const REVIEW = "src/services/attendance/review.ts";
const RETENTION = "src/services/attendance/retention.ts";
const QUEUE = "src/app/(app)/attendance/review/ReviewQueue.tsx";
const MINE = "src/app/(app)/me/attendance/InReview.tsx";
const DOMAIN = "src/domain/attendance/faceMatch.ts";

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

/** Comments quote the code they describe, so a guard must not read them. */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("rejecting takes the mark back", () => {
  it("clears the punch, and only when the verdict is a rejection", () => {
    const body = code(REVIEW);
    expect(body).toMatch(/if \(input\.verdict === "REJECTED" && event\.attendanceDayId\) \{/);
    expect(body).toMatch(/await unmarkDay\(/);
  });

  it("in the same transaction as the verdict", () => {
    // Two writes that can half-happen would leave a mark recorded as rejected
    // and still counted as a present day, which is the exact state this round
    // exists to remove.
    const body = code(REVIEW);
    const tx = body.indexOf("prisma.$transaction");
    const unmark = body.indexOf("await unmarkDay(");
    expect(tx).toBeGreaterThan(-1);
    expect(tx).toBeLessThan(unmark);
  });

  it("zeroes the overtime along with the times", () => {
    /**
     * The quiet one.
     *
     * The payroll engine adds `overtimeMinutes` for every status it sees,
     * including ones it otherwise ignores. A rejected mark that kept its
     * overtime would be a rejected mark that still got paid for the evening,
     * and nothing on any screen would say so.
     */
    const body = code(REVIEW);
    const start = body.indexOf("async function unmarkDay");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    expect(block).toMatch(/overtimeMinutes: 0/);
    expect(block).toMatch(/workedMinutes: 0/);
  });

  it("leaves a week off or a holiday as what it was", () => {
    // Rejecting a mark made on a rest day removes the punch. It does not turn
    // the rest day into an absence, which would dock somebody for a day they
    // were never expected to work.
    const body = code(REVIEW);
    const start = body.indexOf("async function unmarkDay");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    expect(block).toMatch(/day\.status === "FULL_DAY" \|\| day\.status === "HALF_DAY"/);
    expect(block).toMatch(/workedStatus \?/);
  });

  it("keeps the evidence rather than deleting a row", () => {
    // The selfie, the score, the reason and the name of whoever rejected it all
    // stay. An organisation that has already exported its attendance must not
    // find rows missing from the next export.
    const body = code(REVIEW);
    expect(body).not.toMatch(/attendanceEvent\.delete/);
    expect(body).not.toMatch(/attendanceDay\.delete/);
  });
});

describe("and refuses when the month has been closed", () => {
  it("blocks a locked payroll run", () => {
    const body = code(REVIEW);
    expect(body).toMatch(/refusePayrollLocked\(/);
    const start = body.indexOf("async function refusePayrollLocked");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    expect(block).toMatch(/status: "LOCKED"/);
  });

  it("and a salary that has already been paid", () => {
    // LOCKED is the organisation's word that the month is closed; a settlement
    // is somebody's bank statement. The owner's answer was to stop at both.
    const body = code(REVIEW);
    const start = body.indexOf("async function refusePayrollLocked");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    expect(block).toMatch(/settlement: \{ not: "UNPAID" \}/);
  });

  it("but not while the run can still be recalculated", () => {
    // DRAFT, CALCULATED and APPROVED are all re-runnable, and taking a day back
    // before the month is locked is ordinary work rather than a correction.
    const body = code(REVIEW);
    const start = body.indexOf("async function refusePayrollLocked");
    const block = body.slice(start, body.indexOf("\n}\n", start));
    for (const status of ["CALCULATED", "APPROVED", "DRAFT"]) {
      expect(block, status).not.toContain(`"${status}"`);
    }
  });

  it("checks before it writes anything", () => {
    const body = code(REVIEW);
    expect(body.indexOf("refusePayrollLocked(ctx")).toBeLessThan(
      body.indexOf("prisma.$transaction"),
    );
  });
});

describe("the queue only shows people the reader is responsible for", () => {
  it("scopes the list", () => {
    // It filtered on `organizationId` alone, so a supervisor could open every
    // employee's selfie in the company.
    expect(code(REVIEW)).toMatch(/const visible = await visibleEmployeeIds\(ctx, "attendance\.read"\)/);
  });

  it("and the verdict, which is the one that matters", () => {
    // Listing is filtered; deciding is by id, and an id can be typed. There are
    // two `visibleEmployeeIds` calls for that reason.
    const uses = code(REVIEW).match(/visibleEmployeeIds\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  it("and calls somebody else's mark a 404, never a 403", () => {
    // A reader who can tell "not yours" from "no such thing" can enumerate the
    // roster next door. The house rule, applied here too.
    const body = code(REVIEW);
    const start = body.indexOf("if (visible !== null && !visible.includes(event.employeeId))");
    expect(start).toBeGreaterThan(-1);
    expect(body.slice(start, start + 200)).toMatch(/NotFoundError/);
  });
});

describe("a photo somebody is still waiting on is not expired", () => {
  it("the purge skips open reviews", () => {
    /**
     * Rejecting now removes attendance, so deciding blind is not an option --
     * and a mark nobody can decide is one that stays flagged for ever. The
     * sixty-day window still applies the moment somebody has answered.
     */
    expect(code(RETENTION)).toMatch(/NOT: \{ flaggedForReview: true, reviewedAt: null \}/);
  });
});

describe("both screens can name every reason the engine emits", () => {
  /**
   * `NO_FACE` was in both label maps and the engine has never emitted it -- the
   * code is `NO_FACE_DETECTED` -- so that case rendered as "Could not be
   * verified" and told an administrator nothing. The blink reasons were missing
   * outright, and they are about to be the commonest thing in the queue.
   *
   * Read from the union rather than from a list written here, so adding a
   * ninth reason fails this instead of quietly falling through.
   */
  const reasons = (() => {
    const src = source(DOMAIN);
    const start = src.indexOf("export type FaceRejectReason =");
    const block = src.slice(start, src.indexOf(";", start));
    return [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]!);
  })();

  it("finds the union in the first place", () => {
    expect(reasons.length).toBeGreaterThanOrEqual(8);
    expect(reasons).toContain("NO_BLINK");
    expect(reasons).toContain("NO_FACE_DETECTED");
  });

  it("the admin queue labels all of them", () => {
    const body = code(QUEUE);
    for (const reason of reasons) {
      expect(body, reason).toContain(`${reason}:`);
    }
  });

  it("and so does the employee's own screen", () => {
    const body = code(MINE);
    for (const reason of reasons) {
      expect(body, reason).toContain(`${reason}:`);
    }
  });

  it("and neither still carries the code that never existed", () => {
    for (const file of [QUEUE, MINE]) {
      expect(code(file), file).not.toMatch(/\bNO_FACE:/);
    }
  });
});

describe("the queue quotes the organisation's threshold, not a number in a string", () => {
  it("takes it as a prop", () => {
    // It read "the threshold is 36%" in prose. The field is writable through
    // the settings API, so the sentence was one save away from being false on
    // the screen whose whole job is helping somebody judge that number.
    expect(code(QUEUE)).toMatch(/threshold: number/);
    expect(code(QUEUE)).not.toMatch(/threshold is 36%/);
  });
});

describe("the people who can act on a flagged mark are the people told about it", () => {
  /**
   * Three notifications about the review queue named `ADMIN` and `HR_MANAGER`
   * and left the owner out. Every other organisation-level notification in the
   * product names `ORG_OWNER`. On the live instance the organisations have an
   * owner, employees and a kiosk -- nobody in between -- so a check-out that
   * matched at 0.73 but showed no blink sat in the queue for two days, and the
   * owner's question was why the face had not matched.
   */
  const FILES = [
    "src/services/attendance/checkIn.ts",
    "src/services/attendance/kiosk.ts",
    "src/services/attendance/regularisation.ts",
  ];

  it("every attendance notification to roles includes the owner", () => {
    for (const file of FILES) {
      const body = code(file);
      const calls = body.match(/notify\.toOrgRoles\([^\[]*\[[^\]]*\]/g) ?? [];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, file).toContain('"ORG_OWNER"');
      }
    }
  });
});
