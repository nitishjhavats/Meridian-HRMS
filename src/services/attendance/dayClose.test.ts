import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The close of the day writes two kinds of row and nothing else. These pin
 * the conditions that keep it that way; the behaviour itself is exercised by
 * `npm run smoke:day-close` against the seed database.
 */

const SERVICE = "src/services/attendance/dayClose.ts";
const JOBS = "src/lib/jobs.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("closing attendance days", () => {
  const service = code(SERVICE);

  it("settles only an open, unoverridden CHECKED_IN row, and says so again in the write", () => {
    expect(service).toMatch(
      /row\.status !== "CHECKED_IN" \|\| !row\.firstCheckInAt \|\| row\.lastCheckOutAt \|\| row\.overriddenAt/,
    );
    // The write is conditional too: a check-out or an override that landed
    // between the read and the write wins.
    expect(service).toMatch(
      /updateMany\(\{\s*where: \{ id: settlement\.id, status: "CHECKED_IN", overriddenAt: null, lastCheckOutAt: null \}/,
    );
  });

  it("writes absences as system rows that cannot be written twice", () => {
    expect(service).toMatch(/status: "ABSENT",\s*systemStatus: "ABSENT",\s*source: "SYSTEM",\s*remarks: NO_CHECK_IN_REMARK/);
    expect(service).toMatch(/createMany\(\{[\s\S]*?skipDuplicates: true/);
  });

  it("leaves rest days without a row blank, as payroll already reads them", () => {
    expect(service).toMatch(/if \(kind !== "WORKING"\) continue;/);
  });

  it("loads everybody, and applies the roster only to a new absence", () => {
    /**
     * An open CHECKED_IN row belongs to whoever was working that night. With
     * `active: true` and the state filter on the employee query, a person who
     * resigned on the 20th kept the 18th CHECKED_IN for ever and payroll's
     * final month settled it by the default rule. The roster decides who gets
     * a *new* ABSENT row and nothing else.
     */
    expect(service).toMatch(/employee\.findMany\(\{\s*where: \{ organizationId: organization\.id \},/);
    expect(service).toMatch(/const onRoster = employee\.active && !OFF_ROLL_STATES\.includes\(employee\.employmentState\)/);
    expect(service).not.toMatch(/ACTIVE_STATES/);

    const noRow = service.indexOf("if (!row) {");
    const settle = service.indexOf('if (row.status !== "CHECKED_IN"');
    expect(noRow).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(noRow);
    const absenceBranch = service.slice(noRow, settle);
    expect(absenceBranch).toMatch(/if \(!onRoster \|\| !isOnRoll\(roll, date\)\) continue;/);
    // The settlement branch asks nothing about the roster.
    const settleBranch = service.slice(settle, service.indexOf("if (options.dryRun)"));
    expect(settleBranch).not.toMatch(/onRoster|isOnRoll/);
  });

  it("leaves approved leave without a row blank, and counts it", () => {
    // Payroll's leave safety net reads that day as leave; an ABSENT row here
    // would be read first and dock a day already deducted from the balance.
    expect(service).toMatch(/leaveRequest\.findMany\(\{\s*where: \{\s*organizationId: organization\.id,\s*status: "APPROVED",/);
    expect(service).toMatch(/if \(onApprovedLeave\(employee\.id, date\)\) \{\s*summary\.leaveWithoutRow\+\+;/);
    expect(service).toMatch(/reason: "ON_LEAVE"/);
  });

  it("leaves somebody who could not have marked by any path blank, and counts it", () => {
    // Two closed doors -- no work location where one is required, or
    // self-marking off with no kiosk -- are the system's configuration, not
    // the person's absence.
    expect(service).toMatch(/if \(rules\.requireWorkLocation && !employee\.workLocationId\) return true;/);
    expect(service).toMatch(/return !mayMarkFromOwnDevice\(rules, employee\) && !rules\.marking\.kiosk;/);
    expect(service).toMatch(/if \(cannotMark\(employee, await rulesFor\(date\)\)\) \{\s*summary\.unmarkable\+\+;/);
    expect(service).toMatch(/reason: "CANNOT_MARK"/);
    expect(service).toMatch(/workLocationId: true,\s*allowSelfMarking: true,/);
  });

  it("settles a night shift's check-in on the shift day's own axis", () => {
    // A 00:30 arrival on a 22:00 shift sits on the previous date's row and
    // read as minute 30 -- before the shift had started -- so the late
    // minutes came out zero instead of 150.
    expect(service).toMatch(
      /const checkInMinutes = compare\(local\.date, date\) > 0 \? local\.minutes \+ 1440 : local\.minutes;/,
    );
  });

  it("the operator script refuses an organisation that is not ACTIVE, and prints the blanks", () => {
    const script = code("scripts/close-attendance-days.mts");
    expect(script).toMatch(/organization\.status !== "ACTIVE"/);
    expect(script).toMatch(/org\.skipped/);
    expect(script).toMatch(/org\.leaveWithoutRow/);
    expect(script).toMatch(/org\.unmarkable/);
  });

  it("closes only active organisations, and only dates whose window has passed", () => {
    expect(service).toMatch(/status: "ACTIVE",/);
    expect(service).toMatch(/isDateClosed\(date, await rulesFor\(date\), timeZone, now\)/);
  });

  it("asks the rules in force on each date, not today's", () => {
    expect(service).toMatch(/getAttendanceRulesForOrganization\(organization\.id, date\)/);
  });

  it("writes one audit line per organisation, and none when nothing changed", () => {
    expect(service).toMatch(
      /if \(summary\.absentCreated > 0 \|\| summary\.openDaysClosed > 0\) \{\s*await writeAnonymousAudit\(\{[\s\S]*?action: "attendance\.day_closed"/,
    );
  });

  it("never writes on a dry run", () => {
    const dry = service.indexOf("if (options.dryRun)");
    const create = service.indexOf("attendanceDay.createMany(");
    const update = service.indexOf("attendanceDay.updateMany(");
    expect(dry).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(dry);
    expect(update).toBeGreaterThan(dry);
  });

  it("runs from the nightly maintenance pass, before the stamp that says it finished", () => {
    const jobs = code(JOBS);
    const close = jobs.indexOf("closeAttendanceDays({ now: new Date() })");
    const stamp = jobs.indexOf("platformSetting.upsert(");
    expect(close).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(close);
    expect(jobs).toMatch(/attendance: \{\s*organizations: number;\s*absentCreated: number;\s*openDaysClosed: number;[\s\S]*?leaveWithoutRow: number;[\s\S]*?unmarkable: number;\s*\}/);
  });
});
