import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Two ways a one-off adjustment could vanish between being typed and being
 * paid, both pinned against the source because both are database wiring.
 *
 * Reopening a locked month used to create the revision empty. An adjustment is
 * read only from the run being calculated, so the festival bonus the locked run
 * had paid was simply not on the revision, and net came out lower with nothing
 * to say why. The copy now happens in the same transaction as the revision.
 *
 * And an approved run used to offer "Adjust" and then a toast telling somebody
 * to recalculate -- which the service refuses from APPROVED, along with the
 * reopen its own message pointed at. The dialog is a view from approval on, and
 * the message names the way out that exists.
 */

const SERVICE = "src/services/payroll/runs.ts";
const DIALOG = "src/app/(app)/payroll/[id]/Adjustments.tsx";
const CONTROLS = "src/app/(app)/payroll/[id]/RunControls.tsx";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The body of one exported async function, up to the next export. */
function fn(body: string, name: string): string {
  const at = body.indexOf(`export async function ${name}(`);
  expect(at, `no ${name}`).toBeGreaterThan(-1);
  const next = body.indexOf("\nexport ", at + 1);
  return body.slice(at, next === -1 ? undefined : next);
}

describe("reopening a locked run carries its adjustments", () => {
  const reopen = fn(code(SERVICE), "reopenRun");

  it("creates the revision and the copies in one transaction", () => {
    const tx = reopen.slice(reopen.indexOf("$transaction"));
    expect(tx).toMatch(/tx\.payrollRun\.create\(/);
    expect(tx).toMatch(/tx\.payrollAdjustment\.createMany\(/);
    // Nothing writes outside the transaction any more.
    expect(reopen).not.toMatch(/prisma\.payrollRun\.create\(/);
  });

  it("reads the source run's adjustments, not the revision's", () => {
    expect(reopen).toMatch(
      /tx\.payrollAdjustment\.findMany\(\{\n\s*where: \{ organizationId: ctx\.organizationId!, payrollRunId: run!\.id \}/,
    );
  });

  it("copies every field the engine reads, onto the new run, as the reopener", () => {
    const copy = reopen.slice(reopen.indexOf("createMany("), reopen.indexOf("return { revision"));
    expect(copy).toMatch(/payrollRunId: revision\.id/);
    for (const field of ["employeeId", "code", "label", "kind", "amountPaise", "reason"]) {
      expect(copy, field).toMatch(new RegExp(`${field}: adjustment\\.${field}`));
    }
    expect(copy).toMatch(/createdById: ctx\.userId/);
  });

  it("says on the revision's note and in the audit row how many came across", () => {
    expect(reopen).toMatch(/carried over from revision \$\{run!\.revision\}/);
    expect(reopen).toMatch(/adjustmentsCarried: carried/);
  });

  it("a second reopen racing for the same revision number is told, not 500ed", () => {
    expect(reopen).toMatch(/isUniqueViolation\(error, "revision"\)/);
    expect(reopen).toMatch(/throw new ConflictError\(/);
  });
});

describe("recalculating an approved run", () => {
  const calculate = fn(code(SERVICE), "calculateRun");

  it("names the exit that exists -- lock, then reopen -- not the one that does not", () => {
    const refusal = calculate.slice(
      calculate.indexOf('run!.status === "APPROVED"'),
      calculate.indexOf("getPayrollPolicy"),
    );
    expect(refusal).toMatch(/lock it and reopen it as a new revision/);
    expect(refusal).not.toMatch(/Reopen it before recalculating/);
  });
});

describe("the Adjust dialog from approval on", () => {
  const body = code(DIALOG);

  it("only a run that can still be recalculated takes a new line", () => {
    expect(body).toMatch(
      /function isEditable\(runStatus: string\): boolean \{\n\s*return runStatus === "DRAFT" \|\| runStatus === "CALCULATED";/,
    );
    expect(body).toMatch(/const editable = isEditable\(runStatus\)/);
    // The old gate let APPROVED through.
    expect(body).not.toMatch(/const locked = runStatus === "LOCKED"/);
  });

  it("the form, the remove button and Add are all behind the same gate", () => {
    const gates = body.match(/\{editable \? \(/g) ?? [];
    // trigger label, alert, remove button, add form, footer
    expect(gates.length).toBeGreaterThanOrEqual(4);
    expect(body).not.toMatch(/\{!locked \? \(/);
    expect(body).toMatch(/\{editable \? \(\n\s*<div className="space-y-3 border-t border-border pt-4">/);
    expect(body).toMatch(/\{editable \? \(\n\s*<Button\n\s*variant="ghost"\n\s*size="sm"\n\s*disabled=\{busy\}\n\s*aria-label=\{`Remove/);
  });

  it("an approved run is told to lock and reopen, and that the adjustments come along", () => {
    const approved = body.slice(
      body.indexOf('runStatus === "APPROVED" ? ('),
      body.indexOf('runStatus === "LOCKED" ? ('),
    );
    expect(approved).toMatch(/This run is approved, so its figures are fixed/);
    expect(approved).toMatch(/lock the run, then reopen it as a new revision/);
    expect(approved).toMatch(/carried onto the revision/);
  });

  it("reads as a view once it can only show", () => {
    expect(body).toMatch(/\{editable \? "Adjust" : "Adjustments"\}/);
  });
});

describe("the reopen dialog", () => {
  const body = code(CONTROLS);

  it("says the adjustments are copied, and to prune them before recalculating", () => {
    const alert = body.slice(body.indexOf('title="What actually happens"'), body.indexOf("</Alert>", body.indexOf('title="What actually happens"')));
    expect(alert).toMatch(/adjustments[\s\S]*copied\s+onto the revision/);
    expect(alert).toMatch(/remove any that should no longer apply/);
  });

  it("an approved run explains where Recalculate went", () => {
    expect(body).toMatch(/canRun && status === "APPROVED" \? \(/);
    expect(body).toMatch(/lock the run, then reopen it as a new revision/);
  });
});
