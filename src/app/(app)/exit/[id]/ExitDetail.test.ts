import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";

/**
 * Which permission each control on an exit hangs off.
 *
 * An HR Manager holds `exit.manage` and starts every exit. They opened the
 * one they had just created and found a checklist with no buttons, no way to
 * add an item, no "Mark clearance done" and no "Cancel this exit" -- every
 * control was behind `exit.settle`, which only an Admin has. The service had
 * accepted all of those from HR the whole time; only the page said no.
 *
 * So the page now draws two halves: the process under `exit.manage`, the
 * money -- and the close that ends the employment -- under `exit.settle`.
 * The service asks the same of the close, so the two agree.
 */

const DETAIL = "src/app/(app)/exit/[id]/ExitDetail.tsx";
const SERVICE = "src/services/exit/index.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The JSX between two section markers, so a check cannot match the wrong half. */
function between(body: string, from: string, to: string): string {
  const start = body.indexOf(from);
  expect(start, `${from} not found`).toBeGreaterThan(-1);
  const end = body.indexOf(to, start);
  return body.slice(start, end === -1 ? undefined : end);
}

describe("the two permissions really are two", () => {
  it("HR Manager runs exits and cannot settle them; Admin does both", () => {
    expect(ROLE_PERMISSIONS.HR_MANAGER).toContain("exit.manage");
    expect(ROLE_PERMISSIONS.HR_MANAGER).not.toContain("exit.settle");
    expect(ROLE_PERMISSIONS.ADMIN).toContain("exit.manage");
    expect(ROLE_PERMISSIONS.ADMIN).toContain("exit.settle");
  });

  it("the checklist and the cancel are exit.manage in the service", () => {
    const body = code(SERVICE);
    for (const fn of ["setChecklistItem", "addChecklistItem", "cancelExit"]) {
      const block = between(body, `export async function ${fn}(`, "\n}\n");
      expect(block, fn).toMatch(/requireWrite\(ctx, "exit\.manage", "exit"\)/);
      expect(block, fn).not.toMatch(/exit\.settle/);
    }
  });

  it("and closing the exit is the one status change that needs exit.settle", () => {
    const block = between(code(SERVICE), "export async function setExitStatus(", "\n}\n");
    expect(block).toMatch(/requireWrite\(ctx, "exit\.manage", "exit"\)/);
    expect(block).toMatch(/if \(status === "SETTLED"\) requireWrite\(ctx, "exit\.settle", "exit"\)/);
  });
});

describe("the exit page", () => {
  const body = code(DETAIL);

  it("takes both flags, and may be handed only the settle one because the page is gated on manage", () => {
    expect(body).toMatch(/canSettle: boolean;\s*canManage\?: boolean;/);
    expect(body).toMatch(/canManage = true/);
  });

  it("offers the tick and skip on an open clearance item to whoever runs the exit", () => {
    const clearance = between(body, 'title="Clearance"', "{canSettle || settlement ? (");
    expect(clearance).toMatch(/\{!done && canManage \? \(/);
    expect(clearance).toMatch(/status: "COMPLETED"/);
    expect(clearance).toMatch(/status: "SKIPPED"/);
    expect(clearance).not.toMatch(/canSettle/);
  });

  it("and the box for another clearance item", () => {
    const clearance = between(body, 'title="Clearance"', "{canSettle || settlement ? (");
    expect(clearance).toMatch(/\{canManage \? \(\s*<div[^>]*>\s*<Input/);
    expect(clearance).toMatch(/placeholder="Add another clearance item"/);
  });

  it("keeps calculating, approving and paying behind exit.settle", () => {
    const settlement = between(body, 'title="Full and final settlement"', "(canManage || canSettle)");
    expect(settlement).toMatch(/\{canSettle \? \(\s*<Button[^>]*onClick=\{runPreview\}/);
    expect(settlement).toMatch(/\{canSettle && \(!settlement \|\| settlement\.status === "CALCULATED"\) \? \(/);
    expect(settlement).toMatch(/\{canSettle && settlement\?\.status === "CALCULATED" \? \(/);
    expect(settlement).toMatch(/\{canSettle && outstanding > 0 \? \(/);
    expect(settlement).not.toMatch(/canManage/);
  });

  it("but shows the figure, once there is one, to whoever runs the exit", () => {
    expect(body).toMatch(/\{canSettle \|\| settlement \? \(\s*<Section\s*title="Full and final settlement"/);
  });

  it("splits the closing row: clearance and cancel for manage, the close itself for settle", () => {
    const closing = body.slice(body.lastIndexOf("(canManage || canSettle)"));
    expect(closing).toMatch(/\{canManage \? \([\s\S]*?Mark clearance done/);
    expect(closing).toMatch(/\{canSettle \? \([\s\S]*?Close the exit/);
    expect(closing).toMatch(/\{canManage \? \([\s\S]*?Cancel this exit/);
    // The old gate, which hid the whole row from HR.
    expect(body).not.toMatch(/\{canSettle && exit\.status !== "SETTLED"/);
  });
});
