import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ModuleKey } from "@/lib/features";
import { approvalRows, canOpen, canOpenOwn } from "./links";

/**
 * The dashboard used to offer what the sidebar would not.
 *
 * "Salary slips -- Download as PDF" for somebody whose payroll module was off,
 * "Check in / out" for a login with no employee record, an Announcements
 * section with the module switched off: each landed on a designed refusal
 * instead of the thing the card promised. The tiles and quick links now decide
 * with the sidebar's rule, held in `links.ts`, and the page is checked here to
 * be using it.
 */

const PAGE = "src/app/(app)/dashboard/page.tsx";
const LINKS = "src/app/(app)/dashboard/links.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function viewer(permissions: string[], modules: ModuleKey[], employeeId: string | null = "e1") {
  return { employeeId, permissions: new Set(permissions), modules: new Set<ModuleKey>(modules) };
}

describe("canOpen is the sidebar's rule", () => {
  it("needs the permission and, if named, the module", () => {
    expect(canOpen(viewer(["payroll.read.all"], ["payroll"]), "payroll.read.all", "payroll")).toBe(true);
    expect(canOpen(viewer(["payroll.read.all"], []), "payroll.read.all", "payroll")).toBe(false);
    expect(canOpen(viewer([], ["payroll"]), "payroll.read.all", "payroll")).toBe(false);
  });

  it("accepts any one of several permissions", () => {
    expect(canOpen(viewer(["leave.read.team"], ["leave"]), ["leave.read.all", "leave.read.team"], "leave")).toBe(true);
  });

  it("a /me screen also needs an employee record", () => {
    expect(canOpenOwn(viewer(["payroll.read.self"], ["payroll"]), "payroll.read.self", "payroll")).toBe(true);
    expect(canOpenOwn(viewer(["payroll.read.self"], ["payroll"], null), "payroll.read.self", "payroll")).toBe(false);
  });

  it("is the sidebar's rule by calling it, not by copying it", () => {
    // The file said "in one place" over a line-for-line copy of navigation's
    // filter. A copy agrees until one side is edited.
    const links = code(LINKS);
    expect(links).toContain('import { canReach } from "@/lib/navigation"');
    const body = links.slice(links.indexOf("export function canOpen("));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    expect(fn).toMatch(/return canReach\(\{ permission: permission \?\? undefined, module \}, viewer\)/);
    expect(fn).not.toMatch(/\.some\(/);
    expect(fn).not.toMatch(/modules\.has\(/);
  });
});

describe("the approvals list counts only what the person can open", () => {
  const pending = { leaveRequests: 2, documentDeletions: 1, regularisations: 3, reimbursements: 0 };

  it("drops a row whose module is off, and its count with it", () => {
    const rows = approvalRows(
      viewer(["leave.read.team", "attendance.read.team", "document.read.team", "reimbursement.approve"], ["leave", "attendance", "reimbursements"]),
      pending,
    );
    expect(rows.map((r) => r.key)).toEqual(["leaveRequests", "regularisations"]);
    expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(5);
  });

  it("drops a row whose destination the permission would refuse", () => {
    const rows = approvalRows(viewer(["leave.read.team"], ["leave", "attendance", "documents"]), pending);
    expect(rows.map((r) => r.href)).toEqual(["/leave"]);
  });

  it("leaves out a row with nothing pending", () => {
    const rows = approvalRows(
      viewer(["reimbursement.approve", "leave.read.all"], ["leave", "reimbursements"]),
      { ...pending, leaveRequests: 0 },
    );
    expect(rows).toEqual([]);
  });
});

describe("the page decides its links with that rule", () => {
  const body = code(PAGE);

  it("every /me quick link and tile is behind an own-record check", () => {
    expect(body).toMatch(/const ownAttendance = canOpenOwn\(ctx, "attendance\.read\.self", "attendance"\)/);
    expect(body).toMatch(/const ownLeave = canOpenOwn\(ctx, "leave\.read\.self", "leave"\)/);
    expect(body).toMatch(/const ownSalary = canOpenOwn\(ctx, "payroll\.read\.self", "payroll"\)/);
    expect(body).toMatch(/const ownDocuments = canOpenOwn\(ctx, "document\.read\.self", "documents"\)/);
    // The bug in one expression: a /me href that nothing guards.
    expect(body).not.toMatch(/href=\{seesPeople \? "[^"]+" : "\/me\//);
    // Every quick link to a /me screen sits directly inside its own check.
    const links = [...body.matchAll(/\{(own\w+) \? \(\s*<QuickLink href="\/me\/(\w+)"/g)];
    expect(links.map((m) => m[2])).toEqual(["attendance", "leave", "salary", "documents"]);
    expect(body.match(/<QuickLink href="\/me\//g)).toHaveLength(links.length);
  });

  it("payroll tiles need the module, and a team reader gets a way to the page", () => {
    expect(body).toMatch(/const seesPayroll = canOpen\(ctx, "payroll\.read\.all", "payroll"\)/);
    expect(body).toMatch(/const seesTeamPayroll = !seesPayroll && canOpen\(ctx, "payroll\.read\.team", "payroll"\)/);
    expect(body).toMatch(/\{seesTeamPayroll \? \([\s\S]*?href="\/payroll"/);
  });

  it("the announcements section and the approval rows honour their modules", () => {
    expect(body).toMatch(/const seesAnnouncements = canOpen\(ctx, "announcement\.read", "announcements"\)/);
    expect(body).toMatch(/\{seesAnnouncements \? \(\s*<Section title="Announcements">/);
    expect(body).toMatch(/const approvals = approvalRows\(ctx, data\.pending\)/);
    expect(body).toMatch(/const pendingTotal = approvals\.reduce/);
  });

  it("says plainly when the login has no employee record", () => {
    expect(body).toMatch(/Your login is not linked to an employee record/);
  });
});
