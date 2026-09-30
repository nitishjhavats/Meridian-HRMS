import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A started claim can be thrown away.
 *
 * "Start a claim" creates the row before a receipt is attached, so a change
 * of mind -- or a double press -- left an empty draft in "Your claims" for
 * ever: nothing on the screen or in the API removed it. These checks tie the
 * three ends together: the guard the service applies, the action the route
 * accepts, and the button the draft panel offers.
 */

const SERVICE = "src/services/reimbursements/index.ts";
const ROUTE = "src/app/api/reimbursements/[id]/route.ts";
const SCREEN = "src/app/(app)/reimbursements/Claims.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function fn(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("discarding a draft", () => {
  const service = code(SERVICE);
  const discard = fn(service, "discardClaim");
  const guard = fn(service, "ownDraft");

  it("is refused for anybody else's claim and for anything past DRAFT", () => {
    // The one guard every edit to a draft goes through; if discard stops
    // using it, so does the rule.
    expect(discard).toMatch(/await ownDraft\(ctx, claimId\)/);
    expect(guard).toMatch(/claim\.employeeId !== ctx\.employeeId/);
    expect(guard).toMatch(/claim\.status !== "DRAFT"/);
  });

  it("needs the claim permission and a writable organisation, like every other edit", () => {
    expect(discard).toMatch(/requireWrite\(ctx, "reimbursement\.claim", "reimbursements"\)/);
  });

  it("flips the status first, and only from DRAFT, so a submit in flight is not thrown away", () => {
    const flip = discard.indexOf("prisma.reimbursementClaim.updateMany(");
    const files = discard.indexOf("store.delete(");
    const items = discard.indexOf("prisma.reimbursementItem.deleteMany(");
    expect(flip).toBeGreaterThan(-1);
    expect(discard).toMatch(/status: "DRAFT" \},\s*data: \{ status: "CANCELLED"/);
    expect(discard).toMatch(/flipped\.count === 0/);
    // Then the bills, then their rows: a blob without its row is an orphan.
    expect(files).toBeGreaterThan(flip);
    expect(items).toBeGreaterThan(files);
    // A tombstone, not a delete: the claim number must not be reissued.
    expect(discard).not.toMatch(/prisma\.reimbursementClaim\.delete\(/);
  });

  it("keeps the tombstone out of both lists, and an approver's own drafts in", () => {
    const list = fn(service, "listClaims");
    expect(list).toMatch(/where\.status = filters\.status \?\? \{ not: "CANCELLED" \}/);
    expect(list).toMatch(/notIn: \["DRAFT", "CANCELLED"\]/);
    expect(list).toMatch(/employeeId: ctx\.employeeId \?\? "", status: "DRAFT" as const/);
  });

  it("writes what was deleted on the side the audit table reads", () => {
    expect(discard).toMatch(/after: \{ claimNumber: claim\.claimNumber, status: "CANCELLED", billsDeleted: bills\.length \}/);
  });

  it("is one action on the claim route", () => {
    const route = code(ROUTE);
    expect(route).toMatch(/z\.object\(\{ action: z\.literal\("discard"\) \}\)/);
    expect(route).toMatch(/case "discard":\n\s*return json\(await discardClaim\(ctx, params\.id\)\)/);
  });

  it("is offered in the draft panel, and only after a second press", () => {
    const screen = code(SCREEN);
    const panel = screen.slice(screen.indexOf("{editable ? ("), screen.indexOf("{canApprove &&"));
    expect(panel).toMatch(/\{ action: "discard" \}/);
    expect(panel).toMatch(/setDiscarding\(claim\.id\)/);
    expect(panel).toMatch(/Throw away this draft/);
  });
});
