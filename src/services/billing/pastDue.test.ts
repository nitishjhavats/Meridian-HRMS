import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A paying organisation nobody has paid for is read-only, and every screen
 * that says so has to be reading the same fact.
 *
 * Provisioning a PAID organisation without "already paid" writes a full
 * period ahead of it and `PAST_DUE` on the subscription, and the platform
 * owner is told it cannot be used until a payment is approved. Access was
 * derived from the dates alone, so the owner signed in to a whole cycle of
 * full write access, /billing said "Renews on" a date a cycle away, and the
 * "Paid up" switch on the platform promised a lock the product did not have.
 *
 * The rule is in `resolveAccessState` (unit-tested). This pins the callers:
 * they must hand the status over, because a caller that forgets it gets the
 * old, wrong answer -- which is why `SubscriptionWindow.status` is required
 * rather than optional, and the type checker is the guard for any caller
 * this file does not name.
 */

const BILLING_PAGE = "src/app/(app)/billing/page.tsx";
const LICENCE = "src/app/(platform)/platform/organisations/[id]/LicenceAndAi.tsx";
const SEATS = "src/domain/billing/seats.ts";

function code(file: string): string {
  return readFileSync(path.resolve(file), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the subscription status reaches the access decision", () => {
  it("is not optional on the window", () => {
    const seats = code(SEATS);
    const window = seats.slice(
      seats.indexOf("export interface SubscriptionWindow"),
      seats.indexOf("export type AccessState"),
    );
    expect(window).toMatch(/\n\s*status: SubscriptionStatus;/);
    expect(window).not.toMatch(/status\?:/);
  });

  it("from the organisation's billing page", () => {
    const page = code(BILLING_PAGE);
    const call = page.slice(page.indexOf("resolveAccessState("), page.indexOf('"TRIAL_EXPIRED"'));
    expect(call).toMatch(/status: subscription\.status,/);
  });
});

describe("the organisation's billing page", () => {
  const page = code(BILLING_PAGE);

  it("asks for payment rather than announcing a lapse, when nothing was ever paid", () => {
    expect(page).toMatch(
      /const awaitingFirstPayment = access === "PAST_DUE" && subscription\?\.status === "PAST_DUE";/,
    );
    expect(page).toMatch(/awaitingFirstPayment \? \(\n\s*<div className="mb-4">\n\s*<Alert tone="danger" title="Payment is due">/);
  });

  it("does not show a renewal date a cycle away as though it were earned", () => {
    const renews = page.slice(page.indexOf('label="Renews on"'), page.indexOf("</StatGrid>"));
    expect(renews).toMatch(/awaitingFirstPayment \|\| !subscription \? "—"/);
  });
});

describe("the platform's licence screen", () => {
  const screen = code(LICENCE);

  it("offers the Paid up switch only where it does something", () => {
    // Off marks a PAID subscription past due, and that is now enforced. A
    // trial runs to its date and a free organisation is unmetered whatever
    // the switch says, so it is not offered there.
    const at = screen.indexOf('aria-label="Paid up"');
    expect(at).toBeGreaterThan(-1);
    const guard = screen.lastIndexOf('{mode === "PAID" ? (', at);
    const renewsEvery = screen.indexOf('label="Renews every"');
    expect(guard, "the switch is not inside a PAID-only branch").toBeGreaterThan(renewsEvery);
  });

  it("describes the lock the product actually applies", () => {
    expect(screen).toMatch(/Off makes the organisation read-only, whatever the expiry date says/);
    expect(screen).not.toMatch(/until a payment is recorded/);
  });
});
