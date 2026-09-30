import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The confirmation window is the organisation's deadline, not the reviewer's.
 *
 * An order confirmed inside its four hours used to expire anyway if the
 * platform owner did not approve it before `createdAt + windowMinutes`. The
 * organisation reopened /billing and was told the request had expired and to
 * raise a new one "quoting the same reference"; the platform queue swept the
 * order to EXPIRED and refused to approve it. Money already transferred was
 * attached to an order nobody could rescue.
 *
 * The rule now lives in the machine (`clockRunning`: only INITIATED is on the
 * clock) and is unit-tested there. What is pinned here is that every place
 * which reads the window through something other than the machine follows
 * the same rule -- the client-side countdown, and the code list that decides
 * whether an issued code is still live from the raw row.
 */

const CONFIRM = "src/app/(app)/billing/[id]/ConfirmPayment.tsx";
const PAYMENTS = "src/services/platform/payments.ts";
const ORDERS = "src/services/billing/orders.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function bodyOf(file: string, name: string): string {
  const body = code(file);
  const start = body.indexOf(name);
  expect(start, `${name} not found in ${file}`).toBeGreaterThan(-1);
  return body.slice(start, body.indexOf("\n}\n", start));
}

describe("the organisation's confirmation screen", () => {
  const screen = code(CONFIRM);

  it("counts down only while a confirmation is still owed", () => {
    // The screen has its own clock (it ticks every second from `expiresAt`),
    // so it must apply the machine's rule itself or it will announce an
    // expiry the server never records.
    expect(screen).toMatch(/const onTheClock = status === "INITIATED";/);
    expect(screen).toMatch(/const expired = onTheClock && remaining <= 0;/);
  });

  it("tells a waiting organisation the request will not lapse on them", () => {
    const awaiting = screen.slice(
      screen.indexOf('status === "AWAITING_CONFIRMATION"'),
      screen.indexOf("if (nothingToPay)"),
    );
    expect(awaiting).toMatch(/does not expire while it waits/);
    expect(awaiting).not.toMatch(/formatCountdown/);
  });

  it("shows the countdown banner only on the clock", () => {
    const banner = screen.indexOf("Confirm within");
    expect(banner).toBeGreaterThan(-1);
    const guard = screen.lastIndexOf("{onTheClock ? (", banner);
    expect(guard, "the countdown banner is not inside an onTheClock guard").toBeGreaterThan(-1);
  });
});

describe("the services", () => {
  it("settle expiry through the machine, never by comparing the date themselves", () => {
    for (const [file, fn] of [
      [ORDERS, "async function settleExpiry"],
      [PAYMENTS, "export async function listOrders"],
    ] as const) {
      const block = bodyOf(file, fn);
      expect(block, `${fn} in ${file}`).toMatch(/isExpired\(/);
      expect(block, `${fn} in ${file}`).not.toMatch(/expiresAt\s*<=?\s*now/);
    }
  });

  it("keep a code issued against a waiting order live, however old the order is", () => {
    // `listPaymentCodes` reads a narrow select rather than a full row, so it
    // cannot call `isExpired`; it has to spell the rule out with `clockRunning`.
    const block = bodyOf(PAYMENTS, "export async function listPaymentCodes");
    expect(block).toMatch(/clockRunning\(order\.status\) && order\.expiresAt <= now/);
    expect(block).not.toMatch(/\|\| order\.expiresAt <= now/);
  });
});
