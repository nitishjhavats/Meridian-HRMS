import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Starting an exit for somebody whose earlier one was cancelled.
 *
 * The model allows one exit per employee, so a withdrawn resignation's row is
 * reused when the person resigns again. Reusing the row used to mean reusing
 * everything on it: the clearance list came back already ticked, and the
 * settlement calculated for the exit that never happened was still attached,
 * so "Calculate" was gone and the stale figure sat there waiting to be
 * approved. The reopened exit now starts the way a new one does.
 *
 * The one thing that must not be started over is money that went out. Nothing
 * reaches a settlement except through its exit, so one cut loose from a
 * reopened row is on no screen at all -- the statement the person was given,
 * the amount recorded against it, gone. A paid one therefore stops the reopen
 * instead.
 */

const SERVICE = "src/services/exit/index.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function initiate(): string {
  const body = code(SERVICE);
  const start = body.indexOf("export async function initiateExit(");
  expect(start).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("initiateExit on a cancelled row", () => {
  const block = initiate();

  it("still refuses while an exit is open, and only a cancelled one is reused", () => {
    expect(block).toMatch(/if \(existing && existing\.status !== "CANCELLED"\)/);
    expect(block).toMatch(/if \(!existing\) \{\s*return tx\.exitRecord\.create\(/);
  });

  it("throws the old clearance list away and starts the default one again", () => {
    expect(block).toMatch(/tx\.exitChecklistItem\.deleteMany\(\{ where: \{ exitRecordId: existing\.id \} \}\)/);
    const update = block.slice(block.indexOf("tx.exitRecord.update("));
    expect(update).toMatch(/checklist: \{ create: DEFAULT_CHECKLIST \}/);
    // The delete runs before the row is written, so the fresh list is not
    // what gets deleted.
    expect(block.indexOf("tx.exitChecklistItem.deleteMany(")).toBeLessThan(block.indexOf("tx.exitRecord.update("));
  });

  it("cancels the old settlement, approved or not, and cuts it loose", () => {
    // Approved is included: an approved-but-unpaid figure priced an exit that
    // did not happen. Left merely detached, it was on no screen at all.
    expect(block).toMatch(
      /tx\.fnfSettlement\.updateMany\(\{\s*where: \{ exitRecordId: existing\.id, status: \{ in: \["DRAFT", "CALCULATED", "APPROVED"\] \} \},\s*data: \{ status: "CANCELLED" \},/,
    );
    expect(block).toMatch(
      /tx\.fnfSettlement\.updateMany\(\{\s*where: \{ exitRecordId: existing\.id \},\s*data: \{ exitRecordId: null \},/,
    );
    // Cancel first, then detach: once detached the row no longer answers to
    // the exit's id.
    expect(block.indexOf('status: { in: ["DRAFT", "CALCULATED", "APPROVED"] }')).toBeLessThan(
      block.indexOf("data: { exitRecordId: null }"),
    );
  });

  it("but refuses to reopen at all once money went out on the old one", () => {
    // Read with the row, so the answer does not depend on a second query.
    expect(block).toMatch(
      /select: \{ id: true, status: true, settlement: \{ select: \{ status: true, paidPaise: true \} \} \}/,
    );
    // Paid in full, or any amount recorded: it is the payment that matters.
    expect(block).toMatch(
      /existing\.settlement\.status === "PAID" \|\| existing\.settlement\.paidPaise > 0/,
    );
    expect(block).toMatch(
      /throw new ConflictError\(\s*"That employee's earlier exit was cancelled after its settlement was paid, so a new one cannot be started; the paid statement is on the cancelled exit\.",/,
    );
    // Decided before anything is written, so a refused reopen changes nothing.
    expect(block.indexOf('existing.settlement.status === "PAID"')).toBeLessThan(
      block.indexOf("prisma.$transaction("),
    );
  });

  it("does not carry the old interview note or the old starter across", () => {
    const update = block.slice(block.indexOf("tx.exitRecord.update("));
    expect(update).toMatch(/exitInterviewNote: null/);
    expect(block).toMatch(/createdById: ctx\.userId/);
  });

  it("and a race on the one-per-employee constraint reads as the same conflict", () => {
    // Through the shared helper, not a private cast of the Prisma code.
    expect(code(SERVICE)).toMatch(/import \{ isUniqueViolation \} from "@\/lib\/db\/uniqueViolation";/);
    expect(block).toMatch(/if \(isUniqueViolation\(error\)\) \{\s*throw new ConflictError\("An exit is already open for that employee\."\)/);
    expect(block).not.toMatch(/P2002/);
  });
});
