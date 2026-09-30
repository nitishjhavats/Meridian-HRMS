import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A serial has to come from the series, not from how many rows are in the table.
 *
 * This is not a style note. `nextOrderNumber` counted rows and added one, and
 * seat purchases were broken outright on the live instance: ten orders numbered
 * 0005 to 0014 — the first four had been deleted — so the count was 10, the
 * next number offered was 0011, and 0011 already existed. Every attempt to buy
 * seats failed on the unique constraint and reached the buyer as "something
 * went wrong on our side", with or without a coupon. It would never have
 * recovered on its own: a count never catches up with a series that has a gap.
 *
 * The same defect was sitting in `joinEmployeeDirectory`, where an employee
 * count built the owner's code, against a column that is unique per
 * organisation.
 *
 * Source assertions, because what has to be pinned is which query is asked.
 */

const ORDERS = "src/services/billing/orders.ts";
const PROFILE = "src/services/account/profile.ts";
const EMPLOYEES = "src/services/employees/write.ts";

function source(file: string): string {
  return readFileSync(path.resolve(file), "utf8");
}

function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("the next order number", () => {
  it("comes from the highest number in use", () => {
    const block = bodyOf(ORDERS, "export async function nextOrderNumber");
    expect(block).toMatch(/MAX\(CAST\(SUBSTRING\("orderNumber"/);
  });

  it("and never from a row count", () => {
    // The bug, in the one line that caused it.
    const block = bodyOf(ORDERS, "export async function nextOrderNumber");
    expect(block).not.toMatch(/\.count\(/);
    expect(block).not.toMatch(/count \+ 1/);
  });

  it("compares the tail as a number, not as text", () => {
    // "ORD-2026-1000" sorts below "ORD-2026-0999", so an ORDER BY hands back
    // the wrong row the moment the series passes a thousand.
    const block = bodyOf(ORDERS, "export async function nextOrderNumber");
    expect(block).toMatch(/AS INTEGER/);
    expect(block).not.toMatch(/orderBy/);
  });

  it("is bounded by the year, not by the prefix", () => {
    /**
     * The year is what makes a series; the mark is only what it is called.
     * Matching the mark would restart the count at 0001 the moment the platform
     * renamed its invoices, and two invoices numbered 0001 in one year is worse
     * than a prefix that changes mid-series.
     */
    const block = bodyOf(ORDERS, "export async function nextOrderNumber");
    expect(block).toMatch(/LIKE \$\{`%-\$\{year\}-%`\}/);
  });

  it("and carries the platform's own mark, not the buyer's", () => {
    // An organisation's prefix answers "whose employee is this". An invoice
    // number answers "who issued this", and the issuer is always the platform.
    const block = bodyOf(ORDERS, "export async function nextOrderNumber");
    expect(block).toMatch(/invoicePrefix/);
  });
});

describe("and a race between two buyers is retried, not lost", () => {
  /**
   * Reading the highest and inserting the next is two steps. Two people
   * pressing the button in the same second both read the same highest, one
   * wins, and before this the other got an unreadable 500 and lost the order.
   */
  it("the insert goes through the retry", () => {
    expect(code(ORDERS)).toMatch(/createWithOrderNumber\(\(orderNumber\) =>\s*prisma\.\$transaction/);
  });

  it("which re-derives the number each attempt", () => {
    // Retrying with the same number would fail identically four times.
    const block = bodyOf(ORDERS, "async function createWithOrderNumber");
    expect(block).toMatch(/insert\(await nextOrderNumber\(\)\)/);
  });

  it("only for a unique violation, and the last attempt still throws", () => {
    // Swallowing anything else, or swallowing this for ever, would turn a real
    // failure into an order that silently never existed.
    const block = bodyOf(ORDERS, "async function createWithOrderNumber");
    expect(block).toMatch(/attempt === attempts \|\| !isUniqueViolation\(error\)/);
    expect(code(ORDERS)).toMatch(/code === "P2002"/);
  });
});

describe("the owner's employee code uses the same generator as everybody's", () => {
  it("not a second one built from a count", () => {
    const block = bodyOf(PROFILE, "export async function joinEmployeeDirectory");
    expect(block).not.toMatch(/employee\.count\(/);
    expect(block).toMatch(/await suggestEmployeeCode\(ctx\)/);
  });

  it("and that generator takes a maximum, not a count", () => {
    const block = bodyOf(EMPLOYEES, "export async function suggestEmployeeCode");
    expect(block).toMatch(/MAX\(CAST\(SUBSTRING\("employeeCode"/);
    expect(block).not.toMatch(/\.count\(/);
  });

  it("so the padding and prefix are not rebuilt by hand", () => {
    // It hardcoded three digits and pasted the prefix on itself, so an
    // organisation on a longer prefix got a code the rest of the product does
    // not recognise as one of its own.
    const block = bodyOf(PROFILE, "export async function joinEmployeeDirectory");
    expect(block).not.toMatch(/padStart\(3, "0"\)/);
    expect(block).not.toMatch(/employeeCodePrefix/);
  });
});

describe("a bill of zero is confirmed with nothing entered", () => {
  /**
   * The button that offers this appears only when the payable is zero, but a
   * button is not an authorisation. Without the check here this would be a way
   * to submit any order without paying it.
   */
  it("the server checks the order's own payable, not the request", () => {
    const block = bodyOf(ORDERS, "export async function submitNothingToPay");
    expect(block).toMatch(/if \(order\.payablePaise !== 0\)/);
    expect(block).toMatch(/throw new ValidationError/);
  });

  it("through the machine's own action, not a made-up reference", () => {
    // A reference is a claim about a transaction. Inventing one for a bill of
    // zero puts a number on the record that no bank has heard of.
    const block = bodyOf(ORDERS, "export async function submitNothingToPay");
    expect(block).toMatch(/type: "SUBMIT_NOTHING_DUE"/);
    expect(block).not.toMatch(/SUBMIT_REFERENCE/);
  });

  it("and the reviewer is told why the reference is empty", () => {
    const block = bodyOf(ORDERS, "export async function submitNothingToPay");
    expect(block).toMatch(/payerNote: "Nothing to pay/);
  });

  it("the route accepts it, and only with no fields", () => {
    const route = code("src/app/api/billing/orders/[id]/submit/route.ts");
    expect(route).toMatch(/z\.object\(\{ mode: z\.literal\("nothing-due"\) \}\)/);
    expect(route).toMatch(/submitNothingToPay\(ctx, params\.id\)/);
  });

  it("the screen offers it only for a zero payable", () => {
    const form = code("src/app/(app)/billing/[id]/ConfirmPayment.tsx");
    expect(form).toMatch(/const nothingToPay = payablePaise === 0;/);
    expect(form).toMatch(/\{ mode: "nothing-due" \}/);
  });

  it("and hides the QR for an amount nobody can send", () => {
    const page = code("src/app/(app)/billing/[id]/page.tsx");
    expect(page).toMatch(/order\.payablePaise === 0 \? \(/);
  });
});
