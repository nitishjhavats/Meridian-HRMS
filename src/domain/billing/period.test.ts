import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { paidPeriodEnd, paidPeriodStart } from "./period";

/**
 * A payment buys time after the time already paid for.
 *
 * The period used to start at the moment of approval, so a renewal approved
 * early lost the days still running -- and, now that a confirmed order waits
 * for review instead of expiring, an old order approved after a newer one
 * would have cut a paid year short from that day.
 */

const NOW = new Date("2026-09-16T10:00:00.000Z");

describe("where the new paid period starts", () => {
  it("now, when there is no subscription", () => {
    expect(paidPeriodStart(null, NOW)).toEqual(NOW);
  });

  it("now, when the trial is what is running", () => {
    const trial = { billingMode: "TRIAL", status: "TRIAL", currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z") };
    expect(paidPeriodStart(trial, NOW)).toEqual(NOW);
  });

  it("at the end of the paid period still running", () => {
    const end = new Date("2026-10-11T10:30:47.181Z");
    const paid = { billingMode: "PAID", status: "ACTIVE", currentPeriodEnd: end };
    expect(paidPeriodStart(paid, NOW)).toEqual(end);
  });

  it("now, once the paid period has lapsed", () => {
    const paid = { billingMode: "PAID", status: "ACTIVE", currentPeriodEnd: new Date("2026-09-01T00:00:00.000Z") };
    expect(paidPeriodStart(paid, NOW)).toEqual(NOW);
  });

  it("now, when the subscription is marked past due whatever the date says", () => {
    const due = { billingMode: "PAID", status: "PAST_DUE", currentPeriodEnd: new Date("2027-01-01T00:00:00.000Z") };
    expect(paidPeriodStart(due, NOW)).toEqual(NOW);
  });

  it("and the end is that many months on", () => {
    const start = new Date("2026-10-11T10:30:47.181Z");
    expect(paidPeriodEnd(start, 3)).toEqual(new Date("2027-01-11T10:30:47.181Z"));
  });
});

describe("approval uses it", () => {
  const source = readFileSync(path.resolve("src/services/billing/approval.ts"), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("reads the running period inside the transaction, before writing the new one", () => {
    const tx = source.indexOf("prisma.$transaction");
    const start = source.indexOf("paidPeriodStart(existing, now)");
    const write = source.indexOf("currentPeriodStart:");
    expect(tx).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(tx);
    expect(write).toBeGreaterThan(start);
    expect(source).not.toMatch(/periodEnd\.setMonth/);
  });
});
